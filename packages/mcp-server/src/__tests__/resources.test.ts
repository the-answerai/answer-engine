import { describe, expect, it, vi } from 'vitest';
import { ApiError, AnswerEngineClient } from '../api-client.js';
import { readResource, staticResources } from '../resources.js';

function createMockClient(overrides: Partial<AnswerEngineClient> = {}): AnswerEngineClient {
  return {
    getSchema: vi.fn(),
    retrieve: vi.fn(),
    getRecentContent: vi.fn(),
    query: vi.fn(),
    summarize: vi.fn(),
    ask: vi.fn(),
    saveContent: vi.fn(),
    ...overrides,
  } as unknown as AnswerEngineClient;
}

function parseJsonContent(result: { contents: Array<{ text: string }> }): unknown {
  return JSON.parse(result.contents[0].text) as unknown;
}

describe('MCP Resources', () => {
  it('registers schema, tags, and recent static resources', () => {
    expect(staticResources.map((resource) => resource.uri)).toEqual([
      'answer-engine://schema',
      'answer-engine://tags',
      'answer-engine://recent',
    ]);
  });

  it('reads the schema resource as JSON', async () => {
    const schema = {
      contentTypes: { chat: 2 },
      tags: [],
      capabilities: ['search'],
      dateRange: { earliest: '2026-01-01', latest: '2026-01-02' },
    };
    const client = createMockClient({
      getSchema: vi.fn().mockResolvedValue({
        data: schema,
      }),
    });

    const result = await readResource(client, 'answer-engine://schema');

    expect(result.contents[0]).toMatchObject({
      uri: 'answer-engine://schema',
      mimeType: 'application/json',
    });
    expect(parseJsonContent(result)).toEqual(schema);
  });

  it('reads content by id as JSON', async () => {
    const item = {
      id: 'content-1',
      title: 'Memory',
      contentType: 'chat',
      textKind: 'compatibility',
      content: 'Important context',
      tags: [],
      sourceUrl: null,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-02',
    };
    const client = createMockClient({
      retrieve: vi.fn().mockResolvedValue({
        data: { items: [item] },
      }),
    });

    const result = await readResource(client, 'answer-engine://content/content-1');

    expect(client.retrieve).toHaveBeenCalledWith({
      ids: ['content-1'],
      include: ['summary', 'content', 'metadata'],
    });
    expect(parseJsonContent(result)).toEqual(item);
  });

  it('returns tag taxonomy grouped by category', async () => {
    const client = createMockClient({
      getSchema: vi.fn().mockResolvedValue({
        data: {
          contentTypes: {},
          tags: [
            { slug: 'backend', label: 'Backend', category: 'topic', description: null },
            { slug: 'urgent', label: 'Urgent', category: null, description: 'Needs attention' },
          ],
          capabilities: [],
          dateRange: { earliest: null, latest: null },
        },
      }),
    });

    const result = await readResource(client, 'answer-engine://tags');
    const taxonomy = parseJsonContent(result) as {
      name: string;
      totalTags: number;
      children: Array<{ name: string; totalTags: number; children: Array<{ slug: string }> }>;
    };

    expect(taxonomy.name).toBe('tags');
    expect(taxonomy.totalTags).toBe(2);
    expect(taxonomy.children.map((category) => category.name)).toEqual([
      'topic',
      'uncategorized',
    ]);
    expect(taxonomy.children[0].children[0].slug).toBe('backend');
    expect(taxonomy.children[1].children[0].slug).toBe('urgent');
  });

  it('returns recent content items', async () => {
    const items = [
      {
        id: 'content-2',
        title: 'Latest Memory',
        contentType: 'chat',
        createdAt: '2026-01-02',
        updatedAt: '2026-01-02',
      },
    ];
    const client = createMockClient({
      getRecentContent: vi.fn().mockResolvedValue({
        data: items,
      }),
    });

    const result = await readResource(client, 'answer-engine://recent');
    const recent = parseJsonContent(result) as { count: number; items: typeof items };

    expect(client.getRecentContent).toHaveBeenCalledWith(10);
    expect(recent).toEqual({ count: 1, items });
  });

  it('throws for unknown resource URIs', async () => {
    const client = createMockClient();

    await expect(readResource(client, 'answer-engine://missing')).rejects.toThrow(
      'Unknown resource URI',
    );
  });

  it('wraps API errors with MCP-friendly messages', async () => {
    const client = createMockClient({
      getSchema: vi.fn().mockRejectedValue(new ApiError(401, 'INVALID_API_KEY', 'Bad key')),
    });

    await expect(readResource(client, 'answer-engine://schema')).rejects.toThrow(
      'API error (INVALID_API_KEY): Bad key',
    );
  });
});
