import dotenv from 'dotenv';
import { InfisicalSDK } from '@infisical/sdk';
import { promises as fs, existsSync, readFileSync } from 'fs';
import { exec, ChildProcess } from 'child_process';
import { join } from 'path';

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
    private secretPath: string;
    private quiet: boolean;

    private log(message: string): void {
        if (!this.quiet) console.log(message);
    }

    private warn(message: string): void {
        if (!this.quiet) console.warn(message);
    }

    private logError(message: string): void {
        if (!this.quiet) console.error(message);
    }

    constructor(projectRoot: string = process.cwd(), path?: string, quiet: boolean = false) {
        this.projectRoot = projectRoot;
        this.secretPath = path || '/';
        this.quiet = quiet;

        if (path) {
            this.log(`Using secret path: ${path}`);
        }
    }

    async initialize(): Promise<void> {
        this.log('Initializing Secrets Loader...');

        // Primary path: SDK using client id/secret
        try {
            this.log('Primary mode: SDK (client credentials)');
            await this.initSDK();
            await this.loadSecrets();
            await this.saveBackup();
            this.usingSDK = true;
            this.log('Secrets Loader initialized successfully from Infisical SDK');
            this.startPolling();
        } catch (sdkError: any) {
            this.logError(`Failed to initialize via SDK: ${sdkError.message || sdkError}`);
            this.log('Falling back to Infisical CLI (requires logged-in CLI)...');

            // Fallback path: CLI (no backup or polling in pure CLI mode)
            try {
                await this.loadFromCLI();
                this.log('Secrets Loader initialized successfully from Infisical CLI');
            } catch (cliError: any) {
                this.logError(`Failed to initialize via CLI: ${cliError.message || cliError}`);
                this.log('Attempting to load from backup...');
                try {
                    await this.loadBackup();
                    this.log('Using backup secrets (Infisical unavailable)');
                } catch (backupError: any) {
                    this.logError(`No backup available: ${backupError.message || backupError}`);
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
        const explicitEnv = process.env.INFISICAL_ENVIRONMENT;
        if (explicitEnv && explicitEnv.trim()) {
            return explicitEnv.trim();
        }
        // Explicit override takes precedence
        const nodeEnv = (process.env.NODE_ENV || '').toLowerCase();
        switch (nodeEnv) {
            case 'development':
                return 'development';
            case 'dev':
                return 'development';
            case 'staging':
                return 'staging';
            case 'production':
                return 'production';
            case 'prod':
                return 'production';
            default:
                // Sensible default for local usage
                return 'development';
        }
    }

    private async loadFromCLI(): Promise<void> {
        const environment = this.getInfisicalEnvironment();
        const workspaceId = this.getProjectId();
        this.log(`📋 Loading secrets via CLI for environment: ${environment}`);
        this.log(`   Secret Path: ${this.secretPath}`);

        let command = `infisical export --plain --silent --env=${environment} --projectId=${workspaceId} --path=${this.secretPath}`;
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
                this.log(`   Retrying without --projectId flag...`);
                command = `infisical export --env=${environment} --path=${this.secretPath}`;
                try {
                    const result = await execWithStreaming(command, execOptions);
                    stdout = result.stdout;
                    stderr = result.stderr;
                } catch (retryError: any) {
                    // Try one more time without --silent to see actual error
                    const debugCommand = `infisical export --env=${environment} --path=${this.secretPath}`;
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
            this.secrets = dotenv.parse(stdout);

            const secretCount = Object.keys(this.secrets).length;

            // Check if stderr has warnings about inaccessible secrets
            if (stderr && stderr.trim()) {
                this.warn(`CLI warnings: ${stderr.trim()}`);
            }

            if (secretCount === 0) {
                this.warn('No secrets loaded from CLI. This could mean:');
                this.warn('- No secrets exist in this environment');
                this.warn('- You don\'t have access to any secrets');
                this.warn('- CLI authentication failed');
                this.warn(`- Environment "${environment}" might not exist or have a different name`);
            } else {
                this.log(`✓ Loaded ${secretCount} accessible secrets from CLI`);
                this.log(`   Note: Some secrets may be hidden if you don't have access (tags/permissions)`);
            }
        } catch (error: any) {
            // Check if we got any secrets before the error
            const secretCount = Object.keys(this.secrets).length;

            if (secretCount > 0) {
                // We got some secrets before failing - use them
                this.warn(`CLI encountered an error but loaded ${secretCount} secrets before failure`);
                this.warn(`Error: ${error.message || error}`);
                this.log(`Using ${secretCount} accessible secrets that were loaded`);
                return; // Don't throw - we have some secrets to use
            }

            // No secrets loaded - this is a real failure
            this.logError(`CLI load failed: ${error.message || error}`);
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
        this.log('Initializing Infisical SDK...');
        this.log(`   Environment: ${process.env.INFISICAL_ENVIRONMENT || 'production'}`);
        this.log(`   Workspace ID: ${projectId}`);
        if (siteUrl) {
            this.log(`   Base URL: ${siteUrl}`);
        }
        this.log(`   Client ID length: ${clientId.length} chars`);
        this.log(`   Client Secret length: ${clientSecret.length} chars`);

        try {
            const clientConfig: any = {};

            // Add siteUrl if provided (for self-hosted instances)
            if (siteUrl) {
                clientConfig.siteUrl = siteUrl;
            }

            this.client = new InfisicalSDK(clientConfig);

            this.log('✓ Infisical SDK client created');

            // Authenticate using Universal Auth (v4.0.0+ API)
            await this.client.auth().universalAuth.login({
                clientId: clientId,
                clientSecret: clientSecret,
            });

            this.log('Successfully authenticated with Infisical');
        } catch (error: any) {
            this.logError(`Failed to create/authenticate SDK client: ${error.message || error}`);
            if (error.stack) {
                this.logError(`   Stack: ${error.stack}`);
            }
            throw error;
        }
    }

    private async loadSecrets(): Promise<void> {
        try {
            const projectId = this.getProjectId();
            const environment = this.getInfisicalEnvironment();

            this.log(`Fetching secrets from Infisical (${environment})...`);
            this.log(`   Workspace ID: ${projectId}`);
            this.log(`   Environment: ${environment}`);
            this.log(`   Secret Path: ${this.secretPath}`);
            this.log(`   Note: Only secrets accessible to this machine identity will be loaded`);

            const response = await this.client!.secrets().listSecrets({
                projectId: projectId,
                environment: environment,
                secretPath: this.secretPath,
            });

            // In v4.0.0+, response has a 'secrets' property containing the array
            const secretsArray = response.secrets || [];

            this.secrets = secretsArray.reduce((acc: Secrets, item: any) => {
                acc[item.secretKey] = item.secretValue;
                return acc;
            }, {});

            const secretCount = Object.keys(this.secrets).length;
            this.log(`Successfully loaded ${secretCount} accessible secrets from Infisical SDK`);
            if (secretCount > 0) {
                this.log(`   Note: Hidden/tagged secrets without access are automatically filtered`);
            }
            return;
        } catch (error: any) {
            const errorMsg = error.message || String(error);

            this.logError(`Failed to fetch secrets from Infisical:`);
            this.logError(`   Error: ${errorMsg}`);

            // Log more details if available
            if (error.response) {
                this.logError(`   Status: ${error.response.status}`);
                this.logError(`   Data: ${JSON.stringify(error.response.data)}`);
            }
            if (error.code) {
                this.logError(`   Code: ${error.code}`);
            }

            // Let callers decide how to handle fallback (CLI, backup, etc.)
            throw error;
        }
    }

    private async saveBackup(): Promise<void> {
        try {
            const secretCount = Object.keys(this.secrets).length;

            if (secretCount === 0) {
                this.warn('No secrets to save to backup');
                return;
            }

            const backupPath = join(this.projectRoot, this.envBackupPath);
            // Save .env_backup file. Escapes: backslash, double-quote, newline, carriage return for dotenv.parse().
            const escapeEnvValue = (v: string) =>
                v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
            const envContent = Object.entries(this.secrets)
                .map(([key, value]) => `${key}="${escapeEnvValue(value)}"`)
                .join('\n');
            await fs.writeFile(backupPath, envContent);

            this.log(`Backup saved successfully: ${backupPath} (${secretCount} secrets)`);
        } catch (error: any) {
            this.logError(`Failed to save backup: ${error.message || error}`);
            throw error;
        }
    }

    private async loadBackup(): Promise<void> {
        try {
            const backupPath = join(this.projectRoot, this.envBackupPath);
            await fs.access(backupPath);
            const envData = await fs.readFile(backupPath, 'utf8');
            this.secrets = dotenv.parse(envData);
            this.log(`Loaded ${Object.keys(this.secrets).length} secrets from .env_backup`);
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                throw new Error('No backup file found (.env_backup)');
            }
            this.logError('Failed to load backup:' + error);
            throw new Error('No backup available and Infisical is unavailable');
        }
    }

    private startPolling(): void {
        this.log('Starting secret polling (every 60 seconds)...\n');
        this.log('   Backup file: .env_backup will be updated automatically\n');

        setInterval(async () => {
            const timestamp = new Date().toISOString();
            this.log(`\n[${timestamp}] Polling secrets from Infisical...`);

            try {
                const previousCount = Object.keys(this.secrets).length;
                await this.loadSecrets();
                const currentCount = Object.keys(this.secrets).length;

                if (currentCount !== previousCount) {
                    this.log(`Secret count changed: ${previousCount} → ${currentCount}`);
                }

                // Always update .env_backup during polling
                await this.saveBackup();
                this.log('Polling completed successfully - .env_backup updated');

                // Update process.env with new secrets
                this.populateEnv();
            } catch (error: any) {
                this.logError(`Polling failed: ${error.message || error}`);
                this.log('Will retry on next polling cycle');
            }
        }, 60000); // 60 seconds = 1 minute
    }

    getSecrets(): Secrets {
        return { ...this.secrets };
    }
}

