/**
 * Streamable HTTP transport for remote MCP clients.
 */

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { AnswerEngineClient, parseLibraryScope, type McpClientId } from './api-client.js';
import { createAnswerEngineMcpServer, resolveServerCapabilities } from './server.js';

export interface StartHttpServerOptions {
  port: number;
  apiUrl: string;
  apiKey: string;
  clientId?: McpClientId;
  host?: string;
  library?: string;
  path?: string;
}

export interface AnswerEngineHttpServer {
  server: Server;
  url: string;
  close: () => Promise<void>;
}

export interface AnswerEngineHttpFetchHandler {
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  close: () => Promise<void>;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PATH = '/mcp';

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function extractRequestApiKey(req: IncomingMessage): string | undefined {
  return extractApiKey(firstHeader(req.headers['x-api-key']), firstHeader(req.headers.authorization));
}

function extractApiKey(xApiKey: string | undefined, authorization: string | undefined): string | undefined {
  if (xApiKey) return xApiKey.trim();
  const bearerMatch = authorization?.match(/^Bearer\s+(.+)$/i);
  return bearerMatch?.[1]?.trim();
}

function constantTimeEquals(actual: string, expected: string): boolean {
  if (!actual || !expected) return false;
  const actualDigest = createHash('sha256').update(actual).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

function getSessionId(req: IncomingMessage): string | undefined {
  return firstHeader(req.headers['mcp-session-id']);
}

function writeJsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {}
): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    'Content-Type': 'application/json',
    ...headers,
  });
  res.end(JSON.stringify({
    jsonrpc: '2.0',
    error: { code, message },
    id: null,
  }));
}

function writeNotFound(res: ServerResponse): void {
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}

function writeMethodNotAllowed(res: ServerResponse): void {
  writeJsonRpcError(res, 405, -32000, 'Method not allowed.', { Allow: 'GET, POST, DELETE' });
}

function authenticateRequest(req: IncomingMessage, expectedApiKey: string): 'ok' | 'missing' | 'invalid' {
  const requestApiKey = extractRequestApiKey(req);
  return authenticateApiKey(requestApiKey, expectedApiKey);
}

function authenticateHeaders(headers: Headers, expectedApiKey: string): 'ok' | 'missing' | 'invalid' {
  const requestApiKey = extractApiKey(
    headers.get('x-api-key') ?? undefined,
    headers.get('authorization') ?? undefined
  );
  return authenticateApiKey(requestApiKey, expectedApiKey);
}

function authenticateApiKey(
  requestApiKey: string | undefined,
  expectedApiKey: string
): 'ok' | 'missing' | 'invalid' {
  if (!requestApiKey) return 'missing';
  return constantTimeEquals(requestApiKey, expectedApiKey) ? 'ok' : 'invalid';
}

function createClient(options: Pick<StartHttpServerOptions, 'apiUrl' | 'apiKey' | 'clientId' | 'library'>): AnswerEngineClient {
  return new AnswerEngineClient({
    apiUrl: options.apiUrl,
    apiKey: options.apiKey,
    clientId: options.clientId,
    ...parseLibraryScope(options.library),
  });
}

function createJsonRpcResponse(
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify({
    jsonrpc: '2.0',
    error: { code, message },
    id: null,
  }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

export function createHttpMcpFetchHandler(
  options: Omit<StartHttpServerOptions, 'port' | 'host'>
): AnswerEngineHttpFetchHandler {
  const mcpPath = options.path ?? DEFAULT_PATH;
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
  let capabilitiesPromise: Promise<string[] | undefined> | undefined;

  async function createTransport(): Promise<WebStandardStreamableHTTPServerTransport> {
    const client = createClient(options);
    capabilitiesPromise ??= resolveServerCapabilities(client);
    const capabilities = await capabilitiesPromise;
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        transports.set(sessionId, transport);
      },
    });

    transport.onclose = () => {
      const sessionId = transport.sessionId;
      if (sessionId) transports.delete(sessionId);
    };
    transport.onerror = (error) => {
      process.stderr.write(`MCP HTTP transport error: ${error.message}\n`);
    };

    await createAnswerEngineMcpServer(client, { capabilities }).connect(transport);
    return transport;
  }

  async function fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init);
    const requestUrl = new URL(request.url);
    if (requestUrl.pathname !== mcpPath) {
      return new Response('Not found', { status: 404 });
    }

    const authResult = authenticateHeaders(request.headers, options.apiKey);
    if (authResult === 'missing') {
      return createJsonRpcResponse(401, -32001, 'Missing MCP API key.', {
        'WWW-Authenticate': 'Bearer',
      });
    }
    if (authResult === 'invalid') {
      return createJsonRpcResponse(403, -32003, 'Invalid MCP API key.');
    }

    if (request.method !== 'GET' && request.method !== 'POST' && request.method !== 'DELETE') {
      return createJsonRpcResponse(405, -32000, 'Method not allowed.', {
        Allow: 'GET, POST, DELETE',
      });
    }

    const sessionId = request.headers.get('mcp-session-id') ?? undefined;
    let transport = sessionId ? transports.get(sessionId) : undefined;
    let createdTransport = false;

    if (!transport) {
      if (sessionId) {
        return createJsonRpcResponse(404, -32001, 'Session not found');
      }

      if (request.method !== 'POST') {
        return createJsonRpcResponse(400, -32000, 'Bad Request: Mcp-Session-Id header is required');
      }

      transport = await createTransport();
      createdTransport = true;
    }

    try {
      return await transport.handleRequest(request);
    } finally {
      if (createdTransport && !transport.sessionId) {
        await transport.close().catch(() => undefined);
      }
    }
  }

  async function close(): Promise<void> {
    const closeTransports = Array.from(transports.values(), (transport) =>
      transport.close().catch(() => undefined)
    );
    transports.clear();
    await Promise.all(closeTransports);
  }

  return { fetch, close };
}

export async function startHttpServer(
  options: StartHttpServerOptions
): Promise<AnswerEngineHttpServer> {
  const host = options.host ?? DEFAULT_HOST;
  const mcpPath = options.path ?? DEFAULT_PATH;
  const transports = new Map<string, StreamableHTTPServerTransport>();
  let capabilitiesPromise: Promise<string[] | undefined> | undefined;

  async function createTransport(): Promise<StreamableHTTPServerTransport> {
    const client = createClient(options);
    capabilitiesPromise ??= resolveServerCapabilities(client);
    const capabilities = await capabilitiesPromise;

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        transports.set(sessionId, transport);
      },
    });

    transport.onclose = () => {
      const sessionId = transport.sessionId;
      if (sessionId) transports.delete(sessionId);
    };
    transport.onerror = (error) => {
      process.stderr.write(`MCP HTTP transport error: ${error.message}\n`);
    };

    const mcpServer = createAnswerEngineMcpServer(client, { capabilities });
    await mcpServer.connect(transport);

    return transport;
  }

  async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const authResult = authenticateRequest(req, options.apiKey);
    if (authResult === 'missing') {
      writeJsonRpcError(res, 401, -32001, 'Missing MCP API key.', {
        'WWW-Authenticate': 'Bearer',
      });
      return;
    }
    if (authResult === 'invalid') {
      writeJsonRpcError(res, 403, -32003, 'Invalid MCP API key.');
      return;
    }

    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'POST' && method !== 'DELETE') {
      writeMethodNotAllowed(res);
      return;
    }

    const sessionId = getSessionId(req);
    let transport = sessionId ? transports.get(sessionId) : undefined;
    let createdTransport = false;

    if (!transport) {
      if (sessionId) {
        writeJsonRpcError(res, 404, -32001, 'Session not found');
        return;
      }

      if (method !== 'POST') {
        writeJsonRpcError(res, 400, -32000, 'Bad Request: Mcp-Session-Id header is required');
        return;
      }

      transport = await createTransport();
      createdTransport = true;
    }

    try {
      await transport.handleRequest(req, res);
    } catch (error) {
      process.stderr.write(`MCP HTTP request error: ${String(error)}\n`);
      if (!res.headersSent) {
        writeJsonRpcError(res, 500, -32603, 'Internal MCP server error.');
      } else {
        res.destroy(error instanceof Error ? error : undefined);
      }
    } finally {
      if (createdTransport && !transport.sessionId) {
        await transport.close().catch(() => undefined);
      }
    }
  }

  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? host}`);
    if (requestUrl.pathname !== mcpPath) {
      writeNotFound(res);
      return;
    }

    void handleMcpRequest(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(options.port, host);
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : options.port;
  const urlHost = host === '0.0.0.0' ? 'localhost' : host;

  async function close(): Promise<void> {
    const closeTransports = Array.from(transports.values(), (transport) =>
      transport.close().catch(() => undefined)
    );
    transports.clear();
    await Promise.all(closeTransports);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  return {
    server,
    url: `http://${urlHost}:${actualPort}`,
    close,
  };
}
