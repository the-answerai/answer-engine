import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

const libraryId = '11111111-1111-4111-8111-111111111111';
const recipeId = '22222222-2222-4222-8222-222222222222';
const runId = '33333333-3333-4333-8333-333333333333';
const tokenId = '44444444-4444-4444-8444-444444444444';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify({ success: true, data }), { status, headers: { 'content-type': 'application/json' } });
}

function bootstrap(url: string) {
  if (url === '/local-ui/session') return new Response(null, { status: 204 });
  if (url === '/health') return new Response(JSON.stringify({ status: 'healthy', uptime: 1, channel: 'stable' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  return undefined;
}

describe('advanced local workflows', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(cleanup);

  it('mints a scoped token, reveals it once, and never stores it in the token list', async () => {
    window.history.replaceState({}, '', '/settings');
    const rawToken = 'ae_live_creation_only_secret';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input); const base = bootstrap(url); if (base) return base;
      if (url === '/api/v1/settings') return json({ defaultPageSize: 25, defaultLibraryId: null, density: 'comfortable', defaultExportFormat: 'json' });
      if (url === '/api/v1/libraries') return json([{ id: libraryId, name: 'Decisions', slug: 'decisions', description: null, kind: 'user_defined', filter: null, metadata: {}, isActive: true, itemCount: 2, createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z' }]);
      if (url === '/api/v1/access-tokens' && init?.method === 'POST') return json({ id: tokenId, name: 'Recipe agent', description: null, libraryId, keyPrefix: 'ae_live_creation', capabilities: ['read'], expiresAt: null, createdAt: '2026-08-12T00:00:00.000Z', token: rawToken }, 201);
      if (url === '/api/v1/access-tokens') return json([{ id: tokenId, name: 'Existing local agent', description: null, libraryId: null, keyPrefix: 'ae_live_existing', capabilities: ['read'], lastUsedAt: null, expiresAt: null, revokedAt: null, createdAt: '2026-08-12T00:00:00.000Z' }]);
      if (url.startsWith('/api/v1/audit?')) return json({ items: [], hasMore: false, nextCursor: null });
      return json([]);
    });
    const user = userEvent.setup(); render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Mint token' }));
    await user.type(screen.getByLabelText('Name'), 'Recipe agent');
    await user.selectOptions(screen.getByLabelText('Scope'), libraryId);
    await user.click(within(screen.getByRole('dialog', { name: 'Mint local access token' })).getByRole('button', { name: 'Mint token' }));

    expect(await screen.findByText(rawToken)).toBeTruthy();
    expect(screen.getByText(/will not be shown again/i)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Dismiss forever' }));
    expect(screen.queryByText(rawToken)).toBeNull();
    expect(screen.getByText('ae_live_existing…')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/access-tokens', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining(`"libraryId":"${libraryId}"`),
    }));
  });

  it('previews recipe output and exposes failed per-item results with safe retry', async () => {
    window.history.replaceState({}, '', `/libraries/${libraryId}/recipes`);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input); const base = bootstrap(url); if (base) return base;
      if (url === `/api/v1/libraries/${libraryId}`) return json({ id: libraryId, name: 'Decisions', slug: 'decisions', description: null, kind: 'user_defined', filter: null, metadata: {}, isActive: true, itemCount: 2, createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z' });
      if (url === `/api/v1/libraries/${libraryId}/recipes`) return json([{ id: recipeId, libraryId, name: 'Decision extractor', description: 'Find decisions', contentTypes: ['chat'], systemPrompt: 'Analyze.', userPromptTemplate: '{{content}}', outputType: 'decision', outputSchema: null, modelId: null, maxTokens: null, isActive: true, currentVersion: 2, promptHash: 'abcdef0123456789abcdef', createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z' }]);
      if (url.endsWith(`/recipes/${recipeId}/preview`) && init?.method === 'POST') return json({ items: [{ contentId: libraryId, title: 'Source item', output: 'Decision found', provider: 'local', modelId: 'noop' }] });
      if (url.endsWith(`/recipes/${recipeId}/runs`) && !init?.method) return json([{ id: runId, libraryId, recipeId, recipeVersion: 2, status: 'failed', totalCount: 2, processedCount: 2, succeededCount: 1, skippedCount: 0, failedCount: 1, errorMessage: 'One item failed', createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z' }]);
      if (url.endsWith(`/runs/${runId}`)) return json({ id: runId, libraryId, recipeId, recipeVersion: 2, status: 'failed', totalCount: 2, processedCount: 2, succeededCount: 1, skippedCount: 0, failedCount: 1, errorMessage: 'One item failed', createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z', items: [{ id: tokenId, contentId: libraryId, artifactId: null, status: 'failed', outputPreview: null, outputData: null, errorMessage: 'Malformed source', createdAt: '2026-08-12T00:00:00.000Z' }] });
      if (url.endsWith(`/runs/${runId}/retry`) && init?.method === 'POST') return json({ id: crypto.randomUUID(), status: 'queued' }, 202);
      return json([]);
    });
    const user = userEvent.setup(); render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Preview 3 items' }));
    expect(await screen.findByText('Decision found')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /2\/2/ }));
    expect(await screen.findByText('Malformed source')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/libraries/${libraryId}/runs/${runId}/retry`,
      expect.objectContaining({ method: 'POST' }),
    ));
  });

  it('inspects failed batch results and retries only from a terminal state', async () => {
    window.history.replaceState({}, '', '/batch-jobs');
    const jobId = '55555555-5555-4555-8555-555555555555';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input); const base = bootstrap(url); if (base) return base;
      if (url === '/api/v1/batch-jobs?limit=25') return json({ items: [{ id: jobId, libraryId, kind: 'prompt', name: 'Decision batch', status: 'partial_success', input: { prompt: 'Find decisions' }, totalCount: 2, processedCount: 2, succeededCount: 1, failedCount: 1, createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z' }], hasMore: false, nextCursor: null });
      if (url === `/api/v1/batch-jobs/${jobId}`) return json({ id: jobId, libraryId, kind: 'prompt', name: 'Decision batch', status: 'partial_success', input: { prompt: 'Find decisions' }, totalCount: 2, processedCount: 2, succeededCount: 1, failedCount: 1, createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z', results: [{ id: tokenId, contentId: recipeId, status: 'error', output: null, errorMessage: 'Provider rejected one record', createdAt: '2026-08-12T00:00:00.000Z' }] });
      if (url === `/api/v1/batch-jobs/${jobId}/retry` && init?.method === 'POST') return json({ id: runId, status: 'queued' }, 202);
      return json([]);
    });
    const user = userEvent.setup(); render(<App />);

    await user.click(await screen.findByRole('button', { name: /Decision batch/ }));
    expect(await screen.findByText('Provider rejected one record')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Retry safely' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/batch-jobs/${jobId}/retry`,
      expect.objectContaining({ method: 'POST' }),
    ));
  });
});
