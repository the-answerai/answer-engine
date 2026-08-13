import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

const contentId = '11111111-1111-4111-8111-111111111111';

function json(data: unknown, meta?: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify({ success: true, data, ...(meta ? { meta } : {}) }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('primary local workflows', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(cleanup);

  it('asks a grounded question and opens the cited content inspector', async () => {
    window.history.replaceState({}, '', '/answers');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/local-ui/session') return new Response(null, { status: 204 });
      if (url === '/health') return new Response(null, { status: 200 });
      if (url === '/api/v1/tags') return json([]);
      if (url === '/api/v1/agent/ask' && init?.method === 'POST') return json({
        answer: 'The shell was restored [1].',
        citations: [{ contentId, title: 'Shell decision', contentType: 'chat', excerpt: 'Restore the shell.', relevanceScore: 0.91 }],
      });
      if (url === `/api/v1/content/${contentId}`) return json({ id: contentId, title: 'Shell decision', contentType: 'chat', source: 'codex', status: 'active', summary: 'Restore the shell.', content: 'Raw decision.', tags: [], createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z' });
      if (url.endsWith('/lineage')) return json({ source: 'codex', lineage: [] });
      if (url.endsWith('/artifacts') || url.endsWith('/blobs')) return json([]);
      return json([]);
    });
    const user = userEvent.setup();
    render(<App />);

    await user.type(await screen.findByLabelText('Question'), 'What changed?');
    await user.click(screen.getByRole('button', { name: 'Ask local memory' }));
    await user.click(await screen.findByRole('button', { name: /Shell decision/ }));

    expect(await screen.findByRole('dialog', { name: 'Shell decision' })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/agent/ask', expect.objectContaining({
      body: expect.stringContaining('What changed?'),
    }));
  });

  it('previews and imports manual text through the validated import flow', async () => {
    window.history.replaceState({}, '', '/import');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/local-ui/session') return new Response(null, { status: 204 });
      if (url === '/health') return new Response(null, { status: 200 });
      if (url === '/api/v1/libraries') return json([]);
      if (url === '/api/v1/content/import/preview') return json({ format: 'json', rowCount: 1, sample: [{ title: 'Local decision', content: 'Preserve this.', contentType: 'document', source: 'local-ui' }], parseErrors: [] });
      if (url === '/api/v1/content/import' && init?.method === 'POST') return json({ completedItems: 1, failedItems: 0, items: [{ rowIndex: 0, id: contentId, contentType: 'document', sourceIdentifier: 'local-ui:test', title: 'Local decision' }], failures: [] }, undefined, 201);
      return json([]);
    });
    const user = userEvent.setup();
    render(<App />);

    await user.type(await screen.findByLabelText('Title'), 'Local decision');
    await user.type(screen.getByLabelText('Content'), 'Preserve this.');
    await user.click(screen.getByRole('button', { name: 'Preview import' }));
    await user.click(await screen.findByRole('button', { name: 'Import 1 item' }));

    await waitFor(() => expect(screen.getByText('1 imported · 0 failed')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/content/import', expect.objectContaining({ method: 'POST' }));
  });

  it('keeps the import preview open and shows the server error when commit fails', async () => {
    window.history.replaceState({}, '', '/import');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/local-ui/session') return new Response(null, { status: 204 });
      if (url === '/health') return new Response(null, { status: 200 });
      if (url === '/api/v1/libraries') return json([]);
      if (url === '/api/v1/content/import/preview') return json({
        format: 'json', rowCount: 1,
        sample: [{ title: 'Duplicate decision', content: 'Preserve this.', contentType: 'document' }],
        parseErrors: [],
      });
      if (url === '/api/v1/content/import' && init?.method === 'POST') {
        return new Response(JSON.stringify({
          success: false,
          error: { code: 'CONFLICT', message: 'The destination library is no longer available.' },
        }), { status: 409, headers: { 'content-type': 'application/json' } });
      }
      return json([]);
    });
    const user = userEvent.setup();
    render(<App />);

    await user.type(await screen.findByLabelText('Title'), 'Duplicate decision');
    await user.type(screen.getByLabelText('Content'), 'Preserve this.');
    await user.click(screen.getByRole('button', { name: 'Preview import' }));
    await user.click(await screen.findByRole('button', { name: 'Import 1 item' }));

    expect((await screen.findByRole('alert')).textContent).toContain('The destination library is no longer available.');
    expect(screen.getByRole('button', { name: 'Import 1 item' })).toBeTruthy();
  });

  it('filters content with array-backed facets and ISO date boundaries', async () => {
    window.history.replaceState({}, '', '/content');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/local-ui/session') return new Response(null, { status: 204 });
      if (url === '/health') return new Response(null, { status: 200 });
      if (url === '/api/v1/tags') return json([{
        id: '22222222-2222-4222-8222-222222222222',
        slug: 'shipping',
        label: 'Shipping',
        description: null,
        category: null,
        parentId: null,
        color: null,
        metadata: {},
        isActive: true,
        createdAt: '2026-08-12T00:00:00.000Z',
        updatedAt: '2026-08-12T00:00:00.000Z',
      }]);
      if (url.startsWith('/api/v1/content?')) return json([], { hasMore: false, nextCursor: null, total: 0 });
      return json([]);
    });
    const user = userEvent.setup();
    render(<App />);

    await user.selectOptions(await screen.findByLabelText('Type'), 'chat');
    await user.selectOptions(screen.getByLabelText('Source'), 'codex');
    await user.selectOptions(screen.getByLabelText('Tag'), 'shipping');
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-08-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-08-31' } });

    await waitFor(() => {
      const urls = fetchMock.mock.calls.map(([input]) => String(input));
      expect(urls.some((url) => url.includes('contentTypes=chat')
        && url.includes('sources=codex')
        && url.includes('tags=shipping')
        && url.includes('dateFrom=2026-08-01T00%3A00%3A00.000Z')
        && url.includes('dateTo=2026-08-31T23%3A59%3A59.999Z'))).toBe(true);
    });
  });
});
