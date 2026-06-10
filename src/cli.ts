#!/usr/bin/env node

import { Command } from 'commander';
import { spawn } from 'child_process';
import os from 'os';
import dotenv from 'dotenv';
import { SecretsLoader } from './secrets-loader';

const program = new Command();

program
    .name('pandora-jar')
    .description('CLI tool to load Infisical secrets before running Node.js scripts')
    .version('1.1.1');

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

            // Forward termination signals to the child so it can shut down
            // gracefully. Without this, a SIGTERM/SIGINT delivered only to the
            // wrapper (e.g. `kill <pid>`, pm2/systemd/docker stop) never reaches
            // the actual process, leaving it running.
            const forwardedSignals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];
            const forwardSignal = (signal: NodeJS.Signals) => {
                if (!child.killed) {
                    child.kill(signal);
                }
            };
            for (const signal of forwardedSignals) {
                process.on(signal, () => forwardSignal(signal));
            }

            child.on('error', (error) => {
                if (!quiet) console.error('Failed to execute command: ', error);
                process.exit(1);
            });

            child.on('exit', (code, signal) => {
                // Mirror the child's fate: if it was killed by a signal, exit
                // with the conventional 128 + signal-number code.
                if (signal) {
                    const signalNumber = (os.constants.signals as Record<string, number>)[signal] ?? 0;
                    process.exit(128 + signalNumber);
                }
                process.exit(code ?? 0);
            });
        } catch (error: any) {
            if (!quiet) console.error('Failed to load secrets: ', error);
            process.exit(1);
        }
    });

program.parse(process.argv);

