import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AnswerEngineClient, ApiError } from '../api-client.js';

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;
const originalLibrary = process.env.ANSWER_ENGINE_LIBRARY;

describe('AnswerEngineClient', () => {
  let client: AnswerEngineClient;

  beforeEach(() => {
    delete process.env.ANSWER_ENGINE_LIBRARY;
    client = new AnswerEngineClient({ apiUrl: 'http://localhost:5050', apiKey: 'ae_live_test123' });
    mockFetch.mockReset();
  });

  afterEach(() => {
    if (originalLibrary === undefined) {
      delete process.env.ANSWER_ENGINE_LIBRARY;
    } else {
      process.env.ANSWER_ENGINE_LIBRARY = originalLibrary;
    }
  });

  describe('constructor', () => {
    it('strips trailing slashes from apiUrl', async () => {
      const c = new AnswerEngineClient({ apiUrl: 'http://example.com///', apiKey: 'key' });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, data: { contentTypes: {}, tags: [], capabilities: [], dateRange: { earliest: null, latest: null } }}),
      });
      await c.getSchema();
      expect(mockFetch).toHaveBeenCalledWith(
        'http://example.com/api/v1/agent/schema',
        expect.any(Object)
      );
    });
  });

  describe('request handling', () => {
    it('sends API key and MCP surface headers', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, data: { contentTypes: {}, tags: [], capabilities: [], dateRange: { earliest: null, latest: null } }}),
      });

      await client.getSchema();

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:5050/api/v1/agent/schema',
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-API-Key': 'ae_live_test123',
            'X-AE-Surface': 'mcp',
          }),
        })
      );
    });

    it('throws ApiError on non-ok response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ error: { code: 'INVALID_API_KEY', message: 'Invalid key' } }),
      });

      await expect(client.getSchema()).rejects.toThrow(ApiError);
      await expect(client.getSchema()).rejects.toMatchObject({
        statusCode: 401,
        code: 'INVALID_API_KEY',
      });
    });

    it('handles missing error body gracefully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({}),
      });

      await expect(client.getSchema()).rejects.toThrow(ApiError);
    });

    it('sends POST body as JSON for query', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, data: { results: [], total: 0, searchType: 'hybrid' }}),
      });

      await client.query({ query: 'test', searchType: 'hybrid', limit: 5 });

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:5050/api/v1/agent/query');
      expect(options.method).toBe('POST');
      expect(JSON.parse(options.body)).toEqual({ query: 'test', searchType: 'hybrid', limit: 5 });
    });

    it('adds default library slug from ANSWER_ENGINE_LIBRARY when input is unscoped', async () => {
      process.env.ANSWER_ENGINE_LIBRARY = 'customer-wins';
      client = new AnswerEngineClient({ apiUrl: 'http://localhost:5050', apiKey: 'ae_live_test123' });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, data: { results: [], total: 0, searchType: 'hybrid' }}),
      });

      await client.query({ query: 'test' });

      expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
        query: 'test',
        librarySlug: 'customer-wins',
      });
    });

    it('adds default library slug to schema requests', async () => {
      process.env.ANSWER_ENGINE_LIBRARY = 'customer-wins';
      client = new AnswerEngineClient({ apiUrl: 'http://localhost:5050', apiKey: 'ae_live_test123' });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: { contentTypes: {}, tags: [], capabilities: [], dateRange: { earliest: null, latest: null } },
        }),
      });

      await client.getSchema();

      expect(mockFetch.mock.calls[0][0]).toBe(
        'http://localhost:5050/api/v1/agent/schema?librarySlug=customer-wins',
      );
    });

    it('treats UUID ANSWER_ENGINE_LIBRARY values as default library IDs', async () => {
      process.env.ANSWER_ENGINE_LIBRARY = '123e4567-e89b-12d3-a456-426614174000';
      client = new AnswerEngineClient({ apiUrl: 'http://localhost:5050', apiKey: 'ae_live_test123' });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, data: { items: [] }}),
      });

      await client.retrieve({ ids: ['item-1'] });

      expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
        ids: ['item-1'],
        libraryId: '123e4567-e89b-12d3-a456-426614174000',
      });
    });

    it('does not add default scope when input already includes a library scope', async () => {
      process.env.ANSWER_ENGINE_LIBRARY = 'default-library';
      client = new AnswerEngineClient({ apiUrl: 'http://localhost:5050', apiKey: 'ae_live_test123' });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, data: { summary: 'ok', sourceCount: 1 }}),
      });

      await client.summarize({ prompt: 'test', librarySlug: 'explicit-library' });

      expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
        prompt: 'test',
        librarySlug: 'explicit-library',
      });
    });

    it('posts ask requests to /agent/ask with default library scope', async () => {
      process.env.ANSWER_ENGINE_LIBRARY = 'customer-wins';
      client = new AnswerEngineClient({ apiUrl: 'http://localhost:5050', apiKey: 'ae_live_test123' });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            answer: 'Grounded answer',
            citations: [],
            retrievalMode: 'fulltext',
            responseStyle: 'cited',
          },
        }),
      });

      await client.ask({ question: 'What did customers say?', retrievalMode: 'fulltext' });

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:5050/api/v1/agent/ask');
      expect(options.method).toBe('POST');
      expect(JSON.parse(options.body)).toEqual({
        question: 'What did customers say?',
        retrievalMode: 'fulltext',
        librarySlug: 'customer-wins',
      });
    });

    it('posts saveContent requests to /content/import with default library scope', async () => {
      process.env.ANSWER_ENGINE_LIBRARY = 'personal-memory';
      client = new AnswerEngineClient({ apiUrl: 'http://localhost:5050', apiKey: 'ae_live_test123' });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            contentIds: ['content-1'],
            items: [
              {
                rowIndex: 0,
                id: 'content-1',
                contentType: 'chat',
                sourceIdentifier: 'chat-1',
                title: 'Chat Memory',
              },
            ],
            totalItems: 1,
            completedItems: 1,
            failedItems: 0,
            failures: [],
            parseErrors: [],
            requiresIdForIdempotency: false,
          },
        }),
      });

      await client.saveContent({
        items: [
          {
            title: 'Chat Memory',
            content_type: 'chat',
            source_identifier: 'chat-1',
            content: 'Remember this.',
          },
        ],
      });

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:5050/api/v1/content/import');
      expect(options.method).toBe('POST');
      expect(JSON.parse(options.body)).toEqual({
        items: [
          {
            title: 'Chat Memory',
            content_type: 'chat',
            source_identifier: 'chat-1',
            content: 'Remember this.',
          },
        ],
        librarySlug: 'personal-memory',
      });
    });

    it('gets memory lineage from the unmetered content inspection endpoint', async () => {
      const contentId = '33333333-3333-4333-8333-333333333333';
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            source: 'codex',
            origin: { sourceUrl: null, externalId: 'memory-1' },
            currentArtifacts: [],
            lineage: [],
          },
        }),
      });

      await client.getLineage(contentId);

      expect(mockFetch).toHaveBeenCalledWith(
        `http://localhost:5050/api/v1/content/${contentId}/lineage`,
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('soft-removes a memory via DELETE and tolerates a 204 empty body', async () => {
      const contentId = '44444444-4444-4444-8444-444444444444';
      mockFetch.mockResolvedValueOnce({ ok: true, status: 204 });

      const result = await client.deleteContent(contentId);

      expect(mockFetch).toHaveBeenCalledWith(
        `http://localhost:5050/api/v1/content/${contentId}`,
        expect.objectContaining({ method: 'DELETE' }),
      );
      expect(result.data).toBeUndefined();
    });

    it('gets recent content from /content with default library scope', async () => {
      process.env.ANSWER_ENGINE_LIBRARY = 'personal-memory';
      client = new AnswerEngineClient({ apiUrl: 'http://localhost:5050', apiKey: 'ae_live_test123' });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: [],
          meta: { total: 0, hasMore: false },
        }),
      });

      await client.getRecentContent(10);

      expect(mockFetch.mock.calls[0][0]).toBe(
        'http://localhost:5050/api/v1/content?limit=10&sortBy=createdAt&sortDirection=desc&libraryId=personal-memory',
      );
      expect(mockFetch.mock.calls[0][1].method).toBe('GET');
    });
  });

  describe('endpoint methods', () => {
    const mockOkResponse = (data: unknown) => ({
      ok: true,
      json: async () => ({ success: true, data}),
    });

    it('getSchema calls GET /api/v1/agent/schema', async () => {
      mockFetch.mockResolvedValueOnce(mockOkResponse({ contentTypes: {}, tags: [], capabilities: [], dateRange: { earliest: null, latest: null } }));
      await client.getSchema();
      expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:5050/api/v1/agent/schema');
      expect(mockFetch.mock.calls[0][1].method).toBe('GET');
    });

  });
});
