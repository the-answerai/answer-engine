import { Command } from 'commander';
import {
  getConfig,
  getConfigFilePath,
  maskApiKey,
  saveConfig,
} from '../config.js';
import { writeEnvFile } from '../env-generator.js';
import {
  blobsDir,
  configYamlPath,
  envFilePath,
  evalResultsDir,
  evalSetsDir,
  logsDir,
  postgresDataDir,
  redisDataDir,
  resolveAeHome,
  syncCursorFilePath,
} from '../home.js';
import { printError, printHeader, printJson, printSuccess } from '../output.js';
import { loadUserConfig, UserConfigError } from '../user-config.js';

export function getAeHomePaths(): Record<string, string> {
  return {
    home: resolveAeHome(),
    config: configYamlPath(),
    env: envFilePath(),
    postgres: postgresDataDir(),
    redis: redisDataDir(),
    sync_cursors: syncCursorFilePath(),
    blobs: blobsDir(),
    logs: logsDir(),
    eval_sets: evalSetsDir(),
    eval_results: evalResultsDir(),
  };
}

function reportUserConfigError(error: unknown): void {
  if (error instanceof UserConfigError) {
    printError(error.message);
    process.exitCode = 1;
    return;
  }
  throw error;
}

export function registerConfigCommands(program: Command): void {
  const configCmd = program.command('config').description('Manage Answer Engine configuration');

  configCmd
    .command('show')
    .description('Display current API client configuration')
    .action(() => {
      const config = getConfig();

      if (!process.stdout.isTTY) {
        printJson({ ...config, api_key: maskApiKey(config.api_key) });
        return;
      }

      printHeader('API Client Configuration');
      console.log(`  File: ${getConfigFilePath()}`);
      console.log(`  API URL: ${config.api_url}`);
      console.log(`  API Key: ${maskApiKey(config.api_key)}`);
      console.log(`  Output:  ${config.default_output}`);
    });

  configCmd
    .command('set')
    .description('Set an API client configuration value')
    .argument('<key>', 'Config key (api_url, default_output)')
    .argument('<value>', 'Config value')
    .action((key: string, value: string) => {
      const validKeys = ['api_url', 'default_output', 'api_key'];
      if (!validKeys.includes(key)) {
        printError(`Invalid config key: ${key}. Valid keys: ${validKeys.join(', ')}`);
        process.exitCode = 1;
        return;
      }
      saveConfig({ [key]: value });
      printSuccess(`Set ${key} = ${key === 'api_key' ? maskApiKey(value) : value}`);
    });

  configCmd
    .command('path')
    .description('Show the AE_HOME directory and persistent file paths')
    .action(() => {
      const paths = getAeHomePaths();
      if (!process.stdout.isTTY) {
        printJson(paths);
        return;
      }

      printHeader('Answer Engine Home');
      for (const [name, path] of Object.entries(paths)) {
        console.log(`  ${name}: ${path}`);
      }
    });

  configCmd
    .command('validate')
    .description('Validate AE_HOME/config.yaml')
    .action(() => {
      try {
        loadUserConfig();
        printSuccess(`Valid Answer Engine config: ${configYamlPath()}`);
      } catch (error) {
        reportUserConfigError(error);
      }
    });

  configCmd
    .command('gen-env')
    .description('Generate AE_HOME/.env from config.yaml')
    .action(() => {
      try {
        const config = loadUserConfig();
        const path = envFilePath();
        writeEnvFile(config, path);
        printSuccess(`Generated ${path}`);
      } catch (error) {
        reportUserConfigError(error);
      }
    });
}
