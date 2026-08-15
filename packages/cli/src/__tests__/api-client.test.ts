import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnswerEngineClient, ApiError } from '../api-client.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('AnswerEngineClient', () => {
  let client: AnswerEngineClient;

  beforeEach(() => {
    client = new AnswerEngineClient('http://localhost:5050', 'ae_live_test');
    mockFetch.mockReset();
  });

  it('sends API key and CLI surface headers', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: {}}),
    });

    await client.getSchema();
    expect(mockFetch.mock.calls[0][1].headers['X-API-Key']).toBe('ae_live_test');
    expect(mockFetch.mock.calls[0][1].headers['X-AE-Surface']).toBe('cli');
  });

  it('throws ApiError on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: { code: 'INVALID', message: 'Bad key' } }),
    });

    await expect(client.getSchema()).rejects.toThrow(ApiError);
  });

  it('healthCheck throws on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
    await expect(client.healthCheck()).rejects.toThrow(ApiError);
  });

  it('healthCheck returns health data on success', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'healthy', uptime: 123, channel: 'stable' }),
    });
    const result = await client.healthCheck();
    expect(result.status).toBe('healthy');
    expect(mockFetch.mock.calls[0][1].headers['X-AE-Surface']).toBe('cli');
  });

  it('refuses authenticated requests when the API reports another runtime channel', async () => {
    const stagingClient = new AnswerEngineClient(
      'http://localhost:5050',
      'ae_live_test',
      'staging',
    );
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'healthy', uptime: 123, channel: 'stable' }),
    });

    await expect(stagingClient.getSchema()).rejects.toMatchObject({
      code: 'RUNTIME_CHANNEL_MISMATCH',
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:5050/health');
  });

  it('strips trailing slashes from URL', async () => {
    const c = new AnswerEngineClient('http://example.com///', 'key');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: {}}),
    });
    await c.getSchema();
    expect(mockFetch.mock.calls[0][0]).toBe('http://example.com/api/v1/agent/schema');
  });

  it('sends library scope in agent request bodies', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: { results: [], total: 0, searchType: 'hybrid' }}),
    });

    await client.query({ query: 'test', librarySlug: 'customer-wins' });

    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
      query: 'test',
      librarySlug: 'customer-wins',
    });
  });

  it('sends cli-sync surface for synchronous transcript imports', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: { totalItems: 1, completedItems: 1, failedItems: 0, contentIds: ['content-1'] },
      }),
    });

    await client.submitSyncImport({
      librarySlug: 'memory',
      items: [
        {
          title: 'Claude turn',
          content_type: 'chat',
          source_identifier: 'claude-code:conv:turn-1',
        },
      ],
    });

    expect(mockFetch.mock.calls[0][1].headers['X-AE-Surface']).toBe('cli-sync');
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toMatchObject({
      librarySlug: 'memory',
      items: [
        {
          source_identifier: 'claude-code:conv:turn-1',
        },
      ],
    });
  });

  it('deletes synced content by ID with the cli-sync surface', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 204 });

    await client.deleteContent('content-local-1');

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:5050/api/v1/content/content-local-1',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({
          'X-API-Key': 'ae_live_test',
          'X-AE-Surface': 'cli-sync',
        }),
      }),
    );
  });
});
