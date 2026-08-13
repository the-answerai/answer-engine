import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  askMemory,
  clearLegacyBrowserApiKey,
  initializeLocalUiSession,
  listContent,
  listBatchJobs,
  askAnswer,
  getSettings,
  setLibraryMembership,
  listMemories,
  searchMemories,
  updateSettings,
  rowsToCsv,
} from './api';

describe('local API client', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the same-origin browser session without reading or sending an API key', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: { items: [] },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await listMemories();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/content?limit=50&sortBy=createdAt&sortDirection=desc',
      expect.objectContaining({
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(JSON.stringify(fetchMock.mock.calls[0])).not.toContain('ae_live_');
  });

  it('removes the legacy browser-stored API key during upgrade', () => {
    const removeItem = vi.fn();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: { removeItem },
    });

    clearLegacyBrowserApiKey();

    expect(removeItem).toHaveBeenCalledWith('answer-engine-api-key');
  });

  it('does not block local sessions when browser storage is unavailable', () => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: { removeItem: () => { throw new DOMException('Storage disabled'); } },
    });

    expect(() => clearLegacyBrowserApiKey()).not.toThrow();
  });

  it('initializes the HttpOnly local UI session through a same-origin request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));

    await initializeLocalUiSession();

    expect(fetchMock).toHaveBeenCalledWith('/local-ui/session', { credentials: 'same-origin' });
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

  it('surfaces the API error message from an unsuccessful envelope', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      success: false,
      error: { code: 'CONFLICT', message: 'A tag with this slug already exists.' },
    }), { status: 409, headers: { 'content-type': 'application/json' } }));

    await expect(listContent()).rejects.toThrow('A tag with this slug already exists.');
  });

  it('preserves page metadata and encodes workspace filters', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: [{ id: 'content-1', title: 'Decision log' }],
      meta: { hasMore: true, nextCursor: 'next-page', total: 42 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await expect(listContent({
      search: 'decision log',
      contentTypes: ['chat', 'document'],
      sources: ['codex', 'cowork'],
      tags: ['shipping'],
      status: 'active',
      sortBy: 'title',
      sortDirection: 'asc',
      limit: 25,
    })).resolves.toEqual({
      items: [{ id: 'content-1', title: 'Decision log' }],
      meta: { hasMore: true, nextCursor: 'next-page', total: 42 },
    });

    const requestedUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(requestedUrl).toContain('/api/v1/content?');
    expect(requestedUrl).toContain('search=decision+log');
    expect(requestedUrl).toContain('contentTypes=chat%2Cdocument');
    expect(requestedUrl).toContain('sources=codex%2Ccowork');
    expect(requestedUrl).toContain('tags=shipping');
  });

  it('sends library scope for grounded answers and membership overrides', async () => {
    const libraryId = crypto.randomUUID();
    const contentId = crypto.randomUUID();
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: { answer: 'Grounded.', citations: [{ contentId, title: 'Source' }] },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: { libraryId, contentId, mode: 'include', active: true },
      }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await askAnswer({ question: 'What shipped?', libraryId });
    await setLibraryMembership(libraryId, contentId, 'include', true);

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/v1/agent/ask', expect.objectContaining({
      body: JSON.stringify({
        question: 'What shipped?',
        libraryId,
        retrievalMode: 'fulltext',
        responseStyle: 'cited',
      }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/v1/libraries/${libraryId}/includes/${contentId}`,
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('loads and patches safe local settings without credential fields', async () => {
    const settings = {
      defaultPageSize: 50,
      defaultLibraryId: null,
      density: 'compact' as const,
      defaultExportFormat: 'csv' as const,
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      success: true,
      data: settings,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await expect(getSettings()).resolves.toEqual(settings);
    await expect(updateSettings({ defaultPageSize: 50, density: 'compact' })).resolves.toEqual(settings);

    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/v1/settings', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ defaultPageSize: 50, density: 'compact' }),
    }));
    expect(JSON.stringify(fetchMock.mock.calls)).not.toMatch(/providerApiKey|secret/i);
  });

  it('escapes heterogeneous export rows as safe CSV', () => {
    expect(rowsToCsv([
      { title: 'One, two', status: 'ok' },
      { title: 'Quoted "value"', error: 'line one\nline two' },
    ])).toBe('"title","status","error"\n"One, two","ok",""\n"Quoted ""value""","","line one\nline two"');
  });

  it('encodes batch cursors without losing server pagination state', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: { items: [], hasMore: true, nextCursor: 'next-batch-page' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await expect(listBatchJobs({ cursor: 'current page', limit: 50 })).resolves.toEqual({
      items: [], hasMore: true, nextCursor: 'next-batch-page',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/batch-jobs?limit=50&cursor=current+page',
      expect.objectContaining({ credentials: 'same-origin' }),
    );
  });
});
