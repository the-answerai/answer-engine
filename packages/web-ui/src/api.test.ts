import { beforeEach, describe, expect, it, vi } from 'vitest';
import { askMemory, listMemories, saveApiKey, searchMemories } from './api';

const stored = new Map<string, string>();
const localStorage = {
  clear: () => stored.clear(),
  getItem: (key: string) => stored.get(key) ?? null,
  key: (index: number) => [...stored.keys()][index] ?? null,
  get length() { return stored.size; },
  removeItem: (key: string) => { stored.delete(key); },
  setItem: (key: string, value: string) => { stored.set(key, value); },
};

Object.defineProperty(window, 'localStorage', { configurable: true, value: localStorage });

describe('local API client', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('sends the locally stored API key without exposing it in the URL', async () => {
    saveApiKey('ae_live_local-test-key');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: { items: [] },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await listMemories();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/content?limit=50&sortBy=createdAt&sortDirection=desc',
      expect.objectContaining({ headers: expect.objectContaining({ 'x-api-key': 'ae_live_local-test-key' }) }),
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('ae_live_local-test-key');
  });

  it('rejects keys outside the local ae_live_ namespace', () => {
    expect(() => saveApiKey('not-a-local-key')).toThrow('ae_live_');
    expect(window.localStorage.getItem('answer-engine-api-key')).toBeNull();
  });

  it('normalizes query results from the agent envelope', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: { results: [{ id: 'memory-1', title: 'Decision log' }] },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await expect(searchMemories('decision')).resolves.toEqual([
      { id: 'memory-1', title: 'Decision log' },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/agent/query',
      expect.objectContaining({ body: JSON.stringify({ query: 'decision', searchType: 'fulltext', limit: 25 }) }),
    );
  });

  it('returns a stable empty citation list when an answer omits citations', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: { answer: 'No citation was returned.' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await expect(askMemory('What changed?')).resolves.toEqual({
      answer: 'No citation was returned.',
      citations: [],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/agent/ask',
      expect.objectContaining({ body: JSON.stringify({ question: 'What changed?', retrievalMode: 'fulltext', responseStyle: 'cited' }) }),
    );
  });
});
