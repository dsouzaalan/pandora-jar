#!/usr/bin/env node

import { Command } from 'commander';
import { spawn } from 'child_process';
import dotenv from 'dotenv';
import { SecretsLoader } from './secrets-loader';

const program = new Command();

program
    .name('pandora-jar')
    .description('CLI tool to load Infisical secrets before running Node.js scripts')
    .version('1.0.0');

program
    .command('run')
    .description('Load Infisical secrets and execute a command')
    .option('--env <environment>', 'Specify the Infisical environment to load secrets from')
    .option('--path <path>', 'Specify the secret path in Infisical (default: /)')
    .option('--quiet', 'Suppress all console output from the secrets loader')
    .allowUnknownOption()
    .allowExcessArguments(true)
    .action(async (options) => {
        const quiet = options.quiet || false;
        try {
            dotenv.config({ quiet: quiet });

            const environment = options.env;
            const path = options.path;

            // Set NODE_ENV if --env flag is provided
            if (environment) {
                process.env.NODE_ENV = environment;
            }

            const loader = new SecretsLoader(process.cwd(), path, quiet);
            await loader.initialize();

            const dashDashIndex = process.argv.indexOf('--');

            if (dashDashIndex === -1 || dashDashIndex === process.argv.length - 1) {
                if (!quiet) console.error('No command provided after --');
                process.exit(1);
            }

            const command = process.argv.slice(dashDashIndex + 1);

            if (command.length === 0) {
                if (!quiet) console.error('No command provided');
                process.exit(1);
            }

            const [cmd, ...cmdArgs] = command;
            
            const child = spawn(cmd, cmdArgs, {
                stdio: 'inherit',
                shell: true,
                env: process.env,
            });

            child.on('error', (error) => {
                if (!quiet) console.error('Failed to execute command: ', error);
                process.exit(1);
            });

            child.on('exit', (code) => {
                process.exit(code || 0);
            });
        } catch (error: any) {
            if (!quiet) console.error('Failed to load secrets: ', error);
            process.exit(1);
        }
    });

program.parse(process.argv);

