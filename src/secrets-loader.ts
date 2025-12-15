import dotenv from 'dotenv';
import { InfisicalSDK } from '@infisical/sdk';
import { promises as fs, existsSync, readFileSync } from 'fs';
import { exec, ChildProcess } from 'child_process';
import { promisify } from 'util';
import { join, dirname } from 'path';

const execAsync = promisify(exec);

interface ExecResult {
    stdout: string;
    stderr: string;
}

function execWithStreaming(
    command: string,
    options: { cwd?: string }
): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        let process: ChildProcess | null = null;
        let settled = false;

        const settle = (result: ExecResult | Error, isError: boolean) => {
            if (settled) return;
            settled = true;
            if (process && !process.killed) {
                process.kill();
            }
            if (isError) {
                reject(result);
            } else {
                resolve(result as ExecResult);
            }
        };

        try {
            process = exec(command, options);

            if (!process.stdout || !process.stderr) {
                settle(new Error('Failed to create process streams'), true);
                return;
            }

            process.stdout.on('data', (chunk: Buffer) => {
                const data = chunk.toString();
                stdout += data;
                
                if (data.includes('No valid login session found, triggering login flow')) {
                    settle(new Error('No valid login session found, triggering login flow'), true);
                    return;
                }
            });

            process.stderr.on('data', (chunk: Buffer) => {
                const data = chunk.toString();
                stderr += data;
                
                if (data.includes('No valid login session found, triggering login flow')) {
                    settle(new Error('No valid login session found, triggering login flow'), true);
                    return;
                }
            });

            process.on('close', (code) => {
                if (settled) return;
                if (code !== 0 && code !== null) {
                    settle(new Error(`Command failed with exit code ${code}`), true);
                } else {
                    settle({ stdout, stderr }, false);
                }
            });

            process.on('error', (error) => {
                settle(error, true);
            });
        } catch (error) {
            settle(error as Error, true);
        }
    });
}

interface Secrets {
    [key: string]: string;
}

interface InfisicalConfig {
    workspaceId: string;
}

export class SecretsLoader {
    private secrets: Secrets = {};
    private client?: InfisicalSDK;
    private envBackupPath = './.env_backup';
    private usingSDK = false;
    private projectRoot: string;
    private cliEnvironment?: string;
    private cliSlug?: string;

    constructor(projectRoot: string = process.cwd(), environment?: string, slug?: string) {
        this.projectRoot = projectRoot;
        this.cliEnvironment = environment;
        this.cliSlug = slug;
        

        if (slug) {
            // TODO: Implement slug loading
        }
    }

    async initialize(): Promise<void> {
        console.log('Initializing Secrets Loader...');

        // Primary path: SDK using client id/secret
        try {
            console.log('Primary mode: SDK (client credentials)');
            await this.initSDK();
            await this.loadSecrets();
            await this.saveBackup();
            this.usingSDK = true;
            console.log('Secrets Loader initialized successfully from Infisical SDK');
            this.startPolling();
        } catch (sdkError: any) {
            console.error(`Failed to initialize via SDK: ${sdkError.message || sdkError}`);
            console.log('Falling back to Infisical CLI (requires logged-in CLI)...');

            // Fallback path: CLI (no backup or polling in pure CLI mode)
            try {
                await this.loadFromCLI();
                console.log('Secrets Loader initialized successfully from Infisical CLI');
            } catch (cliError: any) {
                console.error(`Failed to initialize via CLI: ${cliError.message || cliError}`);
                console.log('Attempting to load from backup...');
                try {
                    await this.loadBackup();
                    console.log('Using backup secrets (Infisical unavailable)');
                } catch (backupError: any) {
                    console.error(`No backup available: ${backupError.message || backupError}`);
                    // Re-throw the original SDK error to indicate primary failure
                    throw sdkError;
                }
            }
        }

        // Populate process.env with secrets
        this.populateEnv();
    }

    private populateEnv(): void {
        for (const [key, value] of Object.entries(this.secrets)) {
            // Only set if not already in process.env (allows overrides)
            if (!process.env[key]) {
                process.env[key] = value;
            }
        }
    }

    private getInfisicalEnvironment(): string {
        // CLI flag has highest priority
        if (this.cliEnvironment && this.cliEnvironment.trim()) {
            return this.cliEnvironment.trim();
        }

        // Explicit override takes precedence
        const explicitEnv = process.env.INFISICAL_ENVIRONMENT;
        if (explicitEnv && explicitEnv.trim()) {
            return explicitEnv.trim();
        }

        const nodeEnv = (process.env.NODE_ENV || '').toLowerCase();
        switch (nodeEnv) {
            case 'development':
                return 'development';
            case 'dev':
                return 'development';  // Infisical uses 'dev' as the environment name
            case 'staging':
                return 'staging';
            case 'production':
                return 'production';
            case 'prod':
                return 'production';  // Infisical uses 'prod' as the environment name
            default:
                // Sensible default for local usage
                return 'development';  // Infisical default is 'dev'
        }
    }

    private async loadFromCLI(): Promise<void> {
        const environment = this.getInfisicalEnvironment();
        const workspaceId = this.getProjectId();
        console.log(`📋 Loading secrets via CLI for environment: ${environment}`);

        let command = `infisical secrets --plain --silent --env=${environment} --projectId=${workspaceId}`;
        let stdout: string;
        let stderr: string;

        try {
            // Try with workspace ID first
            const execOptions = { cwd: this.projectRoot };
            try {
                const result = await execWithStreaming(command, execOptions);
                stdout = result.stdout;
                stderr = result.stderr;
            } catch (error: any) {
                // If --projectId doesn't work, try without it (CLI might auto-detect from .infisical.json)
                console.log(`   Retrying without --projectId flag...`);
                command = `infisical secrets --plain --silent --env=${environment}`;
                try {
                    const result = await execWithStreaming(command, execOptions);
                    stdout = result.stdout;
                    stderr = result.stderr;
                } catch (retryError: any) {
                    // Try one more time without --silent to see actual error
                    const debugCommand = `infisical secrets --plain --env=${environment}`;
                    try {
                        const debugResult = await execWithStreaming(debugCommand, execOptions);
                        stdout = debugResult.stdout;
                        stderr = debugResult.stderr;
                    } catch (debugError: any) {
                        throw retryError; // Throw the original retry error
                    }
                }
            }

            // Parse stdout for secrets
            const lines = stdout.trim().split('\n').filter(line => line.trim());

            this.secrets = {};
            for (const line of lines) {
                const equalIndex = line.indexOf('=');
                if (equalIndex > 0) {
                    const key = line.substring(0, equalIndex);
                    const value = line.substring(equalIndex + 1);
                    this.secrets[key] = value;
                }
            }

            const secretCount = Object.keys(this.secrets).length;

            // Check if stderr has warnings about inaccessible secrets
            if (stderr && stderr.trim()) {
                console.warn(`CLI warnings: ${stderr.trim()}`);
            }

            if (secretCount === 0) {
                console.warn('No secrets loaded from CLI. This could mean:');
                console.warn('- No secrets exist in this environment');
                console.warn('- You don\'t have access to any secrets');
                console.warn('- CLI authentication failed');
                console.warn(`- Environment "${environment}" might not exist or have a different name`);
            } else {
                console.log(`✓ Loaded ${secretCount} accessible secrets from CLI`);
                if (secretCount > 0) {
                    console.log(`   Note: Some secrets may be hidden if you don't have access (tags/permissions)`);
                }
            }
        } catch (error: any) {
            // Check if we got any secrets before the error
            const secretCount = Object.keys(this.secrets).length;

            if (secretCount > 0) {
                // We got some secrets before failing - use them
                console.warn(`CLI encountered an error but loaded ${secretCount} secrets before failure`);
                console.warn(`Error: ${error.message || error}`);
                console.log(`Using ${secretCount} accessible secrets that were loaded`);
                return; // Don't throw - we have some secrets to use
            }

            // No secrets loaded - this is a real failure
            console.error(`CLI load failed: ${error.message || error}`);
            throw error;
        }
    }

    private getProjectId(): string {
        const configPath = join(this.projectRoot, '.infisical.json');

        if (!existsSync(configPath)) {
            throw new Error(
                `.infisical.json not found in ${this.projectRoot}\n` +
                'Please create .infisical.json with your Infisical workspace ID:\n' +
                '{\n' +
                '  "workspaceId": "your-workspace-id-here"\n' +
                '}'
            );
        }
        
        try {
            const configContent = readFileSync(configPath, 'utf8');
            const configData = JSON.parse(configContent) as InfisicalConfig;
            
            if (!configData || !configData.workspaceId) {
                throw new Error(
                    'workspaceId is required in .infisical.json\n' +
                    'Please ensure your .infisical.json contains:\n' +
                    '{\n' +
                    '  "workspaceId": "your-workspace-id-here"\n' +
                    '}'
                );
            }
            
            if (typeof configData.workspaceId !== 'string' || configData.workspaceId.trim() === '') {
                throw new Error(
                    'workspaceId in .infisical.json must be a non-empty string'
                );
            }
            
            return configData.workspaceId.trim();
        } catch (error: any) {
            if (error instanceof SyntaxError) {
                throw new Error(
                    `Invalid JSON in .infisical.json: ${error.message}\n` +
                    'Please ensure .infisical.json contains valid JSON:\n' +
                    '{\n' +
                    '  "workspaceId": "your-workspace-id-here"\n' +
                    '}'
                );
            }
          
            if (error.message && error.message.includes('workspaceId')) {
                throw error;
            }
            
            throw new Error(
                `Failed to read .infisical.json: ${error.message}\n` +
                'Please ensure the file exists and is readable.'
            );
        }
    }

    private async initSDK(): Promise<void> {
        let clientId = process.env.INFISICAL_CLIENT_ID;
        let clientSecret = process.env.INFISICAL_CLIENT_SECRET;
        let siteUrl = process.env.INFISICAL_BASE_URL;

        if (!clientId || !clientSecret) {
            throw new Error('INFISICAL_CLIENT_ID and INFISICAL_CLIENT_SECRET are required');
        }

        // Trim whitespace and remove any quotes that might have been added
        clientId = clientId.trim().replace(/^["']|["']$/g, '');
        clientSecret = clientSecret.trim().replace(/^["']|["']$/g, '');
        if (siteUrl) {
            siteUrl = siteUrl.trim().replace(/^["']|["']$/g, '');
        }

        if (!clientId || !clientSecret) {
            throw new Error('INFISICAL_CLIENT_ID and INFISICAL_CLIENT_SECRET cannot be empty after trimming');
        }

        const projectId = this.getProjectId();
        console.log('Initializing Infisical SDK...');
        console.log(`   Environment: ${process.env.INFISICAL_ENVIRONMENT || 'production'}`);
        console.log(`   Workspace ID: ${projectId}`);
        if (siteUrl) {
            console.log(`   Base URL: ${siteUrl}`);
        }
        console.log(`   Client ID length: ${clientId.length} chars`);
        console.log(`   Client Secret length: ${clientSecret.length} chars`);

        try {
            const clientConfig: any = {};

            // Add siteUrl if provided (for self-hosted instances)
            if (siteUrl) {
                clientConfig.siteUrl = siteUrl;
            }

            this.client = new InfisicalSDK(clientConfig);

            console.log('✓ Infisical SDK client created');

            // Authenticate using Universal Auth (v4.0.0+ API)
            await this.client.auth().universalAuth.login({
                clientId: clientId,
                clientSecret: clientSecret,
            });

            console.log('Successfully authenticated with Infisical');
        } catch (error: any) {
            console.error(`Failed to create/authenticate SDK client: ${error.message || error}`);
            if (error.stack) {
                console.error(`   Stack: ${error.stack}`);
            }
            throw error;
        }
    }

    private async loadSecrets(): Promise<void> {
        try {
            const projectId = this.getProjectId();
            const environment = this.getInfisicalEnvironment();

            console.log(`Fetching secrets from Infisical (${environment})...`);
            console.log(`   Workspace ID: ${projectId}`);
            console.log(`   Environment: ${environment}`);
            console.log(`   Note: Only secrets accessible to this machine identity will be loaded`);

            const response = await this.client!.secrets().listSecrets({
                projectId: projectId,
                environment: environment,
                secretPath: '/',
            });

            // In v4.0.0+, response has a 'secrets' property containing the array
            const secretsArray = response.secrets || [];

            this.secrets = secretsArray.reduce((acc: Secrets, item: any) => {
                acc[item.secretKey] = item.secretValue;
                return acc;
            }, {});

            const secretCount = Object.keys(this.secrets).length;
            console.log(`Successfully loaded ${secretCount} accessible secrets from Infisical SDK`);
            if (secretCount > 0) {
                console.log(`   Note: Hidden/tagged secrets without access are automatically filtered`);
            }
            return;
        } catch (error: any) {
            const errorMsg = error.message || String(error);
            const errorStack = error.stack || '';

            console.error(`Failed to fetch secrets from Infisical:`);
            console.error(`   Error: ${errorMsg}`);

            // Log more details if available
            if (error.response) {
                console.error(`   Status: ${error.response.status}`);
                console.error(`   Data: ${JSON.stringify(error.response.data)}`);
            }
            if (error.code) {
                console.error(`   Code: ${error.code}`);
            }

            // Let callers decide how to handle fallback (CLI, backup, etc.)
            throw error;
        }
    }

    private async saveBackup(): Promise<void> {
        try {
            const secretCount = Object.keys(this.secrets).length;

            if (secretCount === 0) {
                console.warn('No secrets to save to backup');
                return;
            }

            const backupPath = join(this.projectRoot, this.envBackupPath);
            // Save .env_backup file
            const envContent = Object.entries(this.secrets)
                .map(([key, value]) => `${key}=${value}`)
                .join('\n');
            await fs.writeFile(backupPath, envContent);

            console.log(`Backup saved successfully: ${backupPath} (${secretCount} secrets)`);
        } catch (error: any) {
            console.error(`Failed to save backup: ${error.message || error}`);
            throw error;
        }
    }

    private async loadBackup(): Promise<void> {
        try {
            const backupPath = join(this.projectRoot, this.envBackupPath);
            await fs.access(backupPath);
            const envData = await fs.readFile(backupPath, 'utf8');
            const lines = envData.trim().split('\n').filter(line => line.trim() && !line.startsWith('#'));

            this.secrets = {};
            for (const line of lines) {
                const equalIndex = line.indexOf('=');
                if (equalIndex > 0) {
                    const key = line.substring(0, equalIndex);
                    const value = line.substring(equalIndex + 1);
                    this.secrets[key] = value;
                }
            }
            console.log(`Loaded ${Object.keys(this.secrets).length} secrets from .env_backup`);
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                throw new Error('No backup file found (.env_backup)');
            }
            console.error('Failed to load backup:', error);
            throw new Error('No backup available and Infisical is unavailable');
        }
    }

    private startPolling(): void {
        console.log('Starting secret polling (every 60 seconds)...\n');
        console.log('   Backup file: .env_backup will be updated automatically\n');

        setInterval(async () => {
            const timestamp = new Date().toISOString();
            console.log(`\n[${timestamp}] Polling secrets from Infisical...`);

            try {
                const previousCount = Object.keys(this.secrets).length;
                await this.loadSecrets();
                const currentCount = Object.keys(this.secrets).length;

                if (currentCount !== previousCount) {
                    console.log(`Secret count changed: ${previousCount} → ${currentCount}`);
                }

                // Always update .env_backup during polling
                await this.saveBackup();
                    console.log('Polling completed successfully - .env_backup updated');
                
                // Update process.env with new secrets
                this.populateEnv();
            } catch (error: any) {
                console.error(`Polling failed: ${error.message || error}`);
                console.log('Will retry on next polling cycle');
            }
        }, 60000); // 60 seconds = 1 minute
    }

    getSecrets(): Secrets {
        return { ...this.secrets };
    }
}

