import { describe, expect, it } from 'vitest';
import { verifyMemoryRoundTrip } from '../verify.js';

function response(data: unknown, ok = true, status = 200): Response {
  return { ok, status, json: () => Promise.resolve(data) } as Response;
}

describe('verifyMemoryRoundTrip', () => {
  it('proves remember, recall citation, and inspect_memory lineage over HTTP', async () => {
    const responses = [
      response({
        data: { contentIds: ['content-1'], completedItems: 1 },
      }),
      response({
        data: { results: [{ id: 'content-1' }] },
      }),
      response({
        data: {
          source: 'create-installer',
          origin: { externalId: 'create-installer:marker-1' },
          currentArtifacts: [],
          lineage: [],
        },
      }),
    ];
    const requestedUrls: string[] = [];
    const requestHeaders: Array<NonNullable<RequestInit['headers']>> = [];
    const fetchImpl: typeof fetch = (input, init) => {
      requestedUrls.push(String(input));
      if (init?.headers) requestHeaders.push(init.headers);
      const next = responses.shift();
      if (!next) return Promise.reject(new Error('Unexpected request'));
      return Promise.resolve(next);
    };

    const contentId = await verifyMemoryRoundTrip({
      apiKey: 'ae_live_test',
      marker: 'marker-1',
      fetchImpl,
    });

    expect(contentId).toBe('content-1');
    expect(requestedUrls).toEqual([
      'http://localhost:5050/api/v1/content/import',
      'http://localhost:5050/api/v1/agent/query',
      'http://localhost:5050/api/v1/content/content-1/lineage',
    ]);
    expect(requestHeaders[0]).toMatchObject({ 'X-AE-Surface': 'mcp' });
  });

  it('fails when recall does not cite the memory that was just stored', async () => {
    const responses = [
      response({
        data: { contentIds: ['content-1'], completedItems: 1 },
      }),
      response({ data: { results: [] } }),
    ];
    const fetchImpl: typeof fetch = () => {
      const next = responses.shift();
      if (!next) return Promise.reject(new Error('Unexpected request'));
      return Promise.resolve(next);
    };

    await expect(verifyMemoryRoundTrip({
      apiKey: 'ae_live_test',
      marker: 'marker-2',
      fetchImpl,
    })).rejects.toThrow('did not cite remembered content content-1');
  });
});
