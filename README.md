# Pandora Jar

A powerful CLI tool for loading environment secrets before running commands. Perfect for managing secrets securely in your development workflow without hardcoding sensitive values.

## Features

- 🔐 **Secure Secrets Loading** - Load secrets from your secrets management service before executing commands
- 🔄 **Automatic Fallback** - Falls back to backup `.env_backup` file if secrets service is unavailable
- 🔁 **Live Updates** - Automatically polls and updates secrets every 60 seconds (SDK mode)
- 🎯 **Environment-Aware** - Automatically selects the correct environment based on `NODE_ENV`
- 🚀 **Zero Configuration** - Works out of the box with minimal setup
- 💾 **Backup Support** - Automatically creates and maintains `.env_backup` for offline usage

## Installation

```bash
npm install -g pandora-jar
npm install -g @infisical/cli@0.43.36
```

Or use it locally in your project:

```bash
npm install --save-dev pandora-jar
```

## Quick Start

### 1. Configure Your Project

Initialize infisical project

```shell
infisical init
```

### 2. Set Up Authentication

Choose one of the following authentication methods:

#### Option A: SDK Mode for Servers

Set environment variables for machine-to-machine authentication:

```bash
export INFISICAL_CLIENT_ID="your-client-id"
export INFISICAL_CLIENT_SECRET="your-client-secret"
export INFISICAL_ENVIRONMENT="development"  # Optional: defaults based on NODE_ENV
```

#### Option B: CLI Mode
Ensure you're logged in to the Infisical CLI:

```bash
infisical login
```

### 3. Run Commands with Secrets

```bash
pandora-jar run -- npm start
pandora-jar run -- node server.js
pandora-jar run -- npm test
```

## Usage

### Basic Syntax

```bash
pandora-jar run -- <your-command>
```

The `--` separator is required to distinguish between `pandora-jar` options and your command.

### Examples

```bash
# Run a Node.js application
pandora-jar run -- node app.js

# Run npm scripts
pandora-jar run -- npm run dev
pandora-jar run -- npm test

# Run with environment-specific secrets
NODE_ENV=production pandora-jar run -- npm start

# Explicitly set environment
INFISICAL_ENVIRONMENT=staging pandora-jar run -- npm start

# Run any command
pandora-jar run -- python script.py
pandora-jar run -- docker-compose up
```

## How It Works

### Loading Priority

1. **Primary**: SDK Mode (using `INFISICAL_CLIENT_ID` and `INFISICAL_CLIENT_SECRET`)
   - Loads secrets via Infisical SDK
   - Creates `.env_backup` automatically
   - Polls for updates every 60 seconds

2. **Fallback**: CLI Mode (using Infisical CLI)
   - Uses `infisical secrets` command
   - Requires CLI authentication
   - No automatic backup or polling

3. **Last Resort**: Backup File
   - Loads from `.env_backup` if available
   - Used when Infisical is unavailable

### Environment Detection

The tool automatically selects the environment based on:

1. `INFISICAL_ENVIRONMENT` (explicit override)
2. `NODE_ENV` mapping:
   - `development` / `dev` → `development`
   - `staging` → `staging`
   - `production` / `prod` → `production`
   - Default → `development`

### Secret Updates

In SDK mode, secrets are automatically polled every 60 seconds:
- New secrets are added to `process.env`
- Updated secrets overwrite existing values
- `.env_backup` is updated automatically
- Changes are logged with timestamps

## Configuration

### Project Configuration (`.infisical.json`)

```json
{
  "projectId": "your-project-id-here"
}
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `INFISICAL_CLIENT_ID` | SDK Mode | Client ID for machine-to-machine auth |
| `INFISICAL_CLIENT_SECRET` | SDK Mode | Client secret for machine-to-machine auth |
| `INFISICAL_ENVIRONMENT` | No | Override environment selection |
| `INFISICAL_BASE_URL` | No | Custom base URL (for self-hosted instances) |
| `NODE_ENV` | No | Used to determine environment if `INFISICAL_ENVIRONMENT` not set |

### Backup File (`.env_backup`)

The tool automatically creates and maintains `.env_backup` in SDK mode. This file:
- Contains all loaded secrets in `.env` format
- Is updated automatically during polling
- Can be used as a fallback when Infisical is unavailable
- Should be added to `.gitignore` (contains secrets!)

## Best Practices

### 1. Add Backup to `.gitignore`

```gitignore
.env_backup
.env
.infisical.json
```

### 2. Use Environment-Specific Secrets

```bash
# Development
NODE_ENV=development pandora-jar run -- npm run dev

# Staging
NODE_ENV=staging pandora-jar run -- npm start

# Production
NODE_ENV=production pandora-jar run -- npm start
```

### 3. Prefer SDK Mode for CI/CD

SDK mode is better suited for automated environments:
- No manual CLI login required
- Automatic backup creation
- Live secret updates

### 4. Use CLI Mode for Local Development

CLI mode is convenient for local development:
- Uses your existing CLI session
- No need to manage client credentials
- Faster startup (no polling overhead)

## Troubleshooting

### "No command provided after --"

Make sure to include `--` before your command:

```bash
# ❌ Wrong
pandora-jar run npm start

# ✅ Correct
pandora-jar run -- npm start
```

### ".infisical.json not found"

Create `.infisical.json` in your project root with your project ID.

### "INFISICAL_CLIENT_ID and INFISICAL_CLIENT_SECRET are required"

Either:
- Set these environment variables for SDK mode, or
- Ensure you're logged in to Infisical CLI for CLI mode

### "No secrets loaded"

Check:
- Your project ID is correct
- You have access to secrets in the selected environment
- Your authentication credentials are valid
- The environment exists in your project

### Backup Not Updating

Backup files are only created/updated in SDK mode. CLI mode doesn't create backups.

## Development

### Building

```bash
npm run build
```

### Project Structure

```
pandora-jar/
├── src/
│   ├── cli.ts           # CLI entry point
│   └── secrets-loader.ts # Core secrets loading logic
├── dist/                # Compiled output
└── package.json
```

## License

ISC

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

