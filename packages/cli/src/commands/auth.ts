/**
 * Auth Commands
 * Local API key login and status commands
 */

import { Command } from 'commander';
import { getConfig, saveConfig, maskApiKey, getConfigFilePath } from '../config.js';
import { AnswerEngineClient, ApiError } from '../api-client.js';
import { printSuccess, printError, printHeader, printWarning } from '../output.js';
import { createInterface } from 'readline/promises';

export function registerAuthCommands(program: Command): void {
  const auth = program.command('auth').description('Authentication and API key management');

  auth
    .command('login')
    .description('Save your API key to config')
    .action(async () => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const key = await rl.question('Enter your API key: ');
        if (!key.startsWith('ae_')) {
          printError('Invalid API key format. Keys start with "ae_".');
          process.exit(1);
        }
        saveConfig({ api_key: key });
        printSuccess(`API key saved to ${getConfigFilePath()}`);
      } finally {
        rl.close();
      }
    });

  auth
    .command('status')
    .description('Show local API authentication status')
    .action(async () => {
      const config = getConfig();
      printHeader('Auth Status');
      console.log(`  API URL: ${config.api_url}`);
      console.log(`  API Key: ${maskApiKey(config.api_key)}`);
      console.log(`  Config:  ${getConfigFilePath()}`);

      if (!config.api_key) {
        printWarning('No API key configured. Run: ae auth login');
        return;
      }

      try {
        const client = new AnswerEngineClient(config.api_url, config.api_key);
        const response = await client.getSchema();
        printSuccess('Authenticated.');
      } catch (error) {
        if (error instanceof ApiError && error.statusCode === 401) {
          printError('API key is invalid or expired.');
        } else {
          printError(`Cannot reach API: ${String(error)}`);
        }
      }
    });
}
