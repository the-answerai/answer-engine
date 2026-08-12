import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createHttpMcpFetchHandler,
  type AnswerEngineHttpFetchHandler,
} from '../http-server.js';

interface CapturedApiRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

const API_KEY = 'ae_test_http_mcp_key';
const API_URL = 'http://answer-engine-api.test';
const MCP_URL = 'http://answer-engine-mcp.test/mcp';

const initializeRequest = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'http-test-client', version: '1.0.0' },
  },
};

function createBackendFetch(
  requests: CapturedApiRequest[],
  capabilities: string[] = [
    'fulltext_search',
    'semantic_search',
    'hybrid_search',
    'retrieve',
    'summarize',
    'ask',
    'content_import',
    'content_lineage',
    'content_delete',
  ],
): typeof fetch {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const body = request.body ? await request.json() as unknown : undefined;
    const headers = Object.fromEntries(request.headers.entries());

    requests.push({
      method: request.method,
      url: `${url.pathname}${url.search}`,
      headers,
      body,
    });

    if (request.method === 'GET' && url.pathname === '/api/v1/agent/schema') {
      return Response.json({
        success: true,
        data: {
          contentTypes: {},
          tags: [],
          capabilities,
          dateRange: { earliest: null, latest: null },
        },
      });
    }

    if (request.method === 'POST' && url.pathname === '/api/v1/agent/query') {
      return Response.json({
        success: true,
        data: {
          results: [
            {
              id: 'content-search-1',
              title: 'HTTP MCP Memory',
              contentType: 'chat',
              textKind: 'compatibility',
              relevanceScore: 0.91,
              tags: [],
              summary: 'A memory found through HTTP MCP.',
              createdAt: '2026-06-01T00:00:00.000Z',
            },
          ],
          total: 1,
          searchType: 'hybrid',
        },
      });
    }

    if (request.method === 'POST' && url.pathname === '/api/v1/content/import') {
      const importBody = body as { items?: Array<{ title?: string; source_identifier?: string }> };
      const item = importBody.items?.[0];
      return Response.json({
        success: true,
        data: {
          totalItems: 1,
          completedItems: 1,
          failedItems: 0,
          items: [
            {
              id: 'content-import-1',
              title: item?.title ?? 'Untitled',
              sourceIdentifier: item?.source_identifier ?? 'source-1',
            },
          ],
          requiresIdForIdempotency: false,
          parseErrors: [],
          failures: [],
        },
      });
    }

    return Response.json({
      error: {
        code: 'NOT_FOUND',
        message: `Unhandled test endpoint ${request.method} ${url.pathname}`,
      },
    }, { status: 404 });
  }) as typeof fetch;
}

function firstText(result: unknown): string {
  const maybeResult = result as { content?: Array<{ type: string; text?: string }> };
  return maybeResult.content?.find((item) => item.type === 'text')?.text ?? '';
}

describe('HTTP MCP server', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    const closeFns = cleanup.splice(0).reverse();
    await Promise.all(closeFns.map((close) => close()));
  });

  function createHandler(): AnswerEngineHttpFetchHandler {
    const handler = createHttpMcpFetchHandler({
      apiUrl: API_URL,
      apiKey: API_KEY,
      library: 'personal-memory',
    });
    cleanup.push(handler.close);
    return handler;
  }

  it('requires X-API-Key or Authorization bearer auth for /mcp requests', async () => {
    const handler = createHandler();
    const missingAuthResponse = await handler.fetch(MCP_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(initializeRequest),
    });
    const missingAuthBody = await missingAuthResponse.json() as { error: { message: string } };

    expect(missingAuthResponse.status).toBe(401);
    expect(missingAuthBody.error.message).toContain('Missing MCP API key');

    const invalidAuthResponse = await handler.fetch(MCP_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        'X-API-Key': 'wrong-key',
      },
      body: JSON.stringify(initializeRequest),
    });
    const invalidAuthBody = await invalidAuthResponse.json() as { error: { message: string } };

    expect(invalidAuthResponse.status).toBe(403);
    expect(invalidAuthBody.error.message).toContain('Invalid MCP API key');
  });

  it('accepts Authorization bearer auth for streamable HTTP sessions', async () => {
    const apiRequests: CapturedApiRequest[] = [];
    vi.stubGlobal('fetch', createBackendFetch(apiRequests));
    const handler = createHandler();
    const response = await handler.fetch(MCP_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(initializeRequest),
    });

    expect(response.status).toBe(200);
    const sessionId = response.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    await response.body?.cancel();

    const deleteResponse = await handler.fetch(MCP_URL, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Mcp-Session-Id': sessionId ?? '',
      },
    });

    expect(deleteResponse.status).toBe(200);
    await deleteResponse.body?.cancel();
  });

  it('allows an HTTP MCP client to list tools and call search_content plus append_memory', async () => {
    const apiRequests: CapturedApiRequest[] = [];
    vi.stubGlobal('fetch', createBackendFetch(apiRequests));
    const handler = createHandler();
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
      fetch: handler.fetch,
      requestInit: {
        headers: {
          'X-API-Key': API_KEY,
        },
      },
    });
    const client = new Client({ name: 'answer-engine-http-test', version: '1.0.0' });

    try {
      await client.connect(transport);

      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          'search_content',
          'append_memory',
          'inspect_memory',
          'remember',
          'recall',
          'forget',
          'get_context_pack',
        ])
      );

      const searchResult = await client.callTool({
        name: 'search_content',
        arguments: { query: 'memory over http' },
      });
      expect(firstText(searchResult)).toContain('HTTP MCP Memory');

      const appendResult = await client.callTool({
        name: 'append_memory',
        arguments: {
          title: 'HTTP saved memory',
          content: 'Remember that HTTP transport works.',
          sourceIdentifier: 'http-memory-1',
        },
      });
      expect(firstText(appendResult)).toContain('Content Saved');
    } finally {
      await transport.terminateSession();
      await client.close();
    }

    expect(apiRequests.map((request) => request.url)).toEqual([
      '/api/v1/agent/schema?librarySlug=personal-memory',
      '/api/v1/agent/query',
      '/api/v1/content/import',
    ]);
    expect(apiRequests.every((request) => request.headers['x-api-key'] === API_KEY)).toBe(true);
  });

  it('omits unavailable tools and resolves capabilities once across HTTP sessions', async () => {
    const apiRequests: CapturedApiRequest[] = [];
    vi.stubGlobal('fetch', createBackendFetch(apiRequests, []));
    const handler = createHandler();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
        fetch: handler.fetch,
        requestInit: { headers: { 'X-API-Key': API_KEY } },
      });
      const client = new Client({ name: `capability-test-${attempt}`, version: '1.0.0' });

      try {
        await client.connect(transport);
        const toolNames = (await client.listTools()).tools.map((tool) => tool.name);
        expect(toolNames).toEqual(['list_tags']);
      } finally {
        await transport.terminateSession();
        await client.close();
      }
    }

    expect(apiRequests.map((request) => request.url)).toEqual([
      '/api/v1/agent/schema?librarySlug=personal-memory',
    ]);
  });
});
