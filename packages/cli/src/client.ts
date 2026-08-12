/**
 * Shared client factory
 * Creates an authenticated AnswerEngineClient or exits with error
 */

import { getConfig } from './config.js';
import { AnswerEngineClient, ApiError } from './api-client.js';
import { printError } from './output.js';

export function createClient(): AnswerEngineClient {
  const config = getConfig();
  if (!config.api_key) {
    printError('No API key configured. Run: ae auth login');
    process.exit(3);
  }
  return new AnswerEngineClient(config.api_url, config.api_key);
}

export function handleApiError(error: unknown): never {
  if (error instanceof ApiError) {
    if (error.statusCode === 401) printError('Authentication failed. Check your API key: ae auth status');
    else if (error.statusCode === 429) printError('Rate limit exceeded. Try again later.');
    else printError(`API error (${error.code}): ${error.message}`);
  } else if (error instanceof TypeError) {
    printError('Cannot reach API. Is the server running? (pnpm dev)');
  } else {
    printError(String(error));
  }
  process.exit(2);
}
