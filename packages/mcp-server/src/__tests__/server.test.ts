import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnswerEngineClient } from '../api-client.js';
import {
  createAnswerEngineMcpServer,
  MCP_SERVER_VERSION,
  resolveServerCapabilities,
} from '../server.js';

const ALL_LOCAL_CAPABILITIES = [
  'fulltext_search',
  'semantic_search',
  'hybrid_search',
  'retrieve',
  'summarize',
  'ask',
  'content_import',
  'content_lineage',
  'content_delete',
];

const ALL_LOCAL_TOOLS = [
  'search_content',
  'get_content',
  'list_tags',
  'summarize_collection',
  'ask',
  'save_content',
  'append_memory',
  'remember',
  'recall',
  'get_context_pack',
  'forget',
  'inspect_memory',
];

function createMockClient(capabilities: string[] = []): AnswerEngineClient {
  return {
    getSchema: vi.fn().mockResolvedValue({
      data: {
        contentTypes: {},
        tags: [],
        capabilities,
        dateRange: { earliest: null, latest: null },
      },
    }),
  } as unknown as AnswerEngineClient;
}

async function listToolNames(capabilities?: string[]): Promise<string[]> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createAnswerEngineMcpServer(createMockClient(), { capabilities });
  const client = new Client({ name: 'capability-test-client', version: '1.0.0' });

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return (await client.listTools()).tools.map((tool) => tool.name);
  } finally {
    await client.close();
    await server.close();
  }
}

describe('capability-based MCP tool registration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('derives the advertised server version from the package manifest', () => {
    expect(MCP_SERVER_VERSION).toBe('1.1.0');
  });

  it('lists the complete local-memory tool family for the OSS schema', async () => {
    await expect(listToolNames(ALL_LOCAL_CAPABILITIES)).resolves.toEqual(ALL_LOCAL_TOOLS);
  });

  it('maps each API capability to only its dependent tools', async () => {
    await expect(listToolNames(['content_import'])).resolves.toEqual([
      'list_tags',
      'save_content',
      'append_memory',
      'remember',
    ]);
    await expect(listToolNames(['hybrid_search'])).resolves.toEqual([
      'search_content',
      'list_tags',
      'recall',
      'get_context_pack',
    ]);
  });

  it('fails closed for API-backed tools when capabilities are unknown', async () => {
    await expect(listToolNames()).resolves.toEqual(['list_tags']);
  });

  it('resolves capabilities from the agent schema', async () => {
    const client = createMockClient(['hybrid_search', 'retrieve']);

    await expect(resolveServerCapabilities(client)).resolves.toEqual([
      'hybrid_search',
      'retrieve',
    ]);
    expect(client.getSchema).toHaveBeenCalledOnce();
  });

  it('returns no capabilities when schema resolution fails', async () => {
    const client = createMockClient();
    vi.mocked(client.getSchema).mockRejectedValue(new Error('API unavailable'));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(resolveServerCapabilities(client)).resolves.toEqual([]);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('Failed to resolve MCP capabilities'),
    );
  });
});
