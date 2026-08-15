/**
 * System Commands
 * ae status, ae schema
 */

import { Command } from 'commander';
import { getConfig } from '../config.js';
import { AnswerEngineClient, ApiError } from '../api-client.js';
import { printError, printSuccess, printSchema } from '../output.js';
import { resolveRuntimeChannel } from '../channel.js';

export function registerSystemCommands(program: Command): void {
  program
    .command('status')
    .description('Check API health and authentication')
    .action(async () => {
      const config = getConfig();
      const client = new AnswerEngineClient(config.api_url, config.api_key, resolveRuntimeChannel());

      try {
        const health = await client.healthCheck();
        printSuccess(`${health.channel} API is ${health.status} (uptime: ${Math.round(health.uptime)}s)`);
      } catch {
        printError(`Cannot reach API at ${config.api_url}`);
        process.exit(2);
      }

      if (config.api_key) {
        try {
          await client.getSchema();
          printSuccess('API key authenticated.');
        } catch (error) {
          if (error instanceof ApiError && error.statusCode === 401) {
            printError('API key is invalid or expired.');
          }
        }
      } else {
        console.log('  Set an API key to verify authentication: ae auth login');
      }
    });

  program
    .command('schema')
    .description('Show full content schema')
    .action(async () => {
      const config = getConfig();
      if (!config.api_key) {
        printError('No API key configured. Run: ae auth login');
        process.exit(3);
      }

      const client = new AnswerEngineClient(config.api_url, config.api_key, resolveRuntimeChannel());
      try {
        const response = await client.getSchema();
        printSchema(response.data as unknown as Record<string, unknown>);
      } catch (error) {
        if (error instanceof ApiError) printError(`API error: ${error.message}`);
        else printError(String(error));
        process.exit(2);
      }
    });
}
