#!/usr/bin/env node
/**
 * Answer Engine MCP Server
 * Provides local Answer Engine memory and retrieval capabilities via MCP.
 */

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AnswerEngineClient, parseLibraryScope } from './api-client.js';
import { startHttpServer, type AnswerEngineHttpServer } from './http-server.js';
import { createAnswerEngineMcpServer, resolveServerCapabilities } from './server.js';
import { z } from 'zod';

export type McpTransportMode = 'stdio' | 'http';

export interface RuntimeConfig {
  apiUrl: string;
  apiKey: string;
  clientId?: 'codex' | 'chatgpt-desktop' | 'claude-code' | 'claude-desktop' | 'cursor';
  library?: string;
  httpPort: number;
  httpHost: string;
  transport: McpTransportMode;
}

export const DEFAULT_API_URL = 'http://localhost:5050';
const DEFAULT_HTTP_PORT = 3333;
const DEFAULT_HTTP_HOST = '127.0.0.1';
const McpClientIdSchema = z.enum(['codex', 'chatgpt-desktop', 'claude-code', 'claude-desktop', 'cursor']);

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid ANSWER_ENGINE_MCP_PORT: ${value}`);
  }
  return port;
}

function getTransportArg(argv: string[]): string | undefined {
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--transport') {
      return argv[index + 1];
    }
    if (arg.startsWith('--transport=')) {
      return arg.slice('--transport='.length);
    }
  }
  return undefined;
}

export function resolveTransportMode(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env
): McpTransportMode {
  const value = (getTransportArg(argv) ?? env.ANSWER_ENGINE_MCP_TRANSPORT ?? 'stdio')
    .trim()
    .toLowerCase();

  if (value === 'stdio') return 'stdio';
  if (value === 'http' || value === 'streamable-http' || value === 'sse') return 'http';
  throw new Error(`Unsupported MCP transport: ${value}`);
}

export function resolveRuntimeConfig(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env
): RuntimeConfig {
  return {
    apiUrl: env.ANSWER_ENGINE_API_URL ?? DEFAULT_API_URL,
    apiKey: env.ANSWER_ENGINE_API_KEY ?? '',
    clientId: env.ANSWER_ENGINE_CLIENT_ID ? McpClientIdSchema.parse(env.ANSWER_ENGINE_CLIENT_ID) : undefined,
    library: env.ANSWER_ENGINE_LIBRARY,
    httpPort: parsePort(env.ANSWER_ENGINE_MCP_PORT, DEFAULT_HTTP_PORT),
    httpHost: env.ANSWER_ENGINE_MCP_HOST ?? DEFAULT_HTTP_HOST,
    transport: resolveTransportMode(argv, env),
  };
}

function createClient(config: RuntimeConfig): AnswerEngineClient {
  return new AnswerEngineClient({
    apiUrl: config.apiUrl,
    apiKey: config.apiKey,
    clientId: config.clientId,
    ...parseLibraryScope(config.library),
  });
}

export async function startStdioServer(config: RuntimeConfig): Promise<void> {
  const client = createClient(config);
  const capabilities = await resolveServerCapabilities(client);
  const server = createAnswerEngineMcpServer(client, { capabilities });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('Answer Engine MCP server started\n');
}

function installShutdownHandlers(httpServer: AnswerEngineHttpServer): void {
  let closing = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (closing) return;
    closing = true;
    process.stderr.write(`Answer Engine MCP HTTP server shutting down (${signal})\n`);
    httpServer
      .close()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        process.stderr.write(`Failed to shut down MCP HTTP server: ${String(error)}\n`);
        process.exit(1);
      });
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

export async function main(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const config = resolveRuntimeConfig(argv, env);

  if (!config.apiKey) {
    process.stderr.write('Warning: ANSWER_ENGINE_API_KEY not set. API calls will fail.\n');
  }

  if (config.transport === 'http') {
    const httpServer = await startHttpServer({
      port: config.httpPort,
      host: config.httpHost,
      apiUrl: config.apiUrl,
      apiKey: config.apiKey,
      clientId: config.clientId,
      library: config.library,
    });
    installShutdownHandlers(httpServer);
    process.stderr.write(`Answer Engine MCP HTTP server started at ${httpServer.url}/mcp\n`);
    return;
  }

  await startStdioServer(config);
}

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1];
  return Boolean(entrypoint && fileURLToPath(import.meta.url) === resolve(entrypoint));
}

if (isDirectExecution()) {
  main().catch((error) => {
    process.stderr.write(`Fatal error: ${String(error)}\n`);
    process.exit(1);
  });
}
