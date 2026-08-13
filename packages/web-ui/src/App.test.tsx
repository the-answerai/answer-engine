import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify({ success: true, data }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installApiMock() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url === '/local-ui/session') return new Response(null, { status: 204 });
    if (url === '/health') return new Response(null, { status: 200 });
    if (url.startsWith('/api/v1/content')) return json([]);
    if (url.startsWith('/api/v1/tags')) return json([]);
    if (url.startsWith('/api/v1/libraries')) return json([]);
    return json({});
  });
}

describe('local application shell', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('bootstraps the local session and redirects the root route to Content', async () => {
    const fetchMock = installApiMock();

    render(<App />);

    expect(document.body.contains(await screen.findByRole('heading', { name: 'Content' }))).toBe(true);
    await waitFor(() => expect(window.location.pathname).toBe('/content'));
    expect(fetchMock).toHaveBeenCalledWith('/local-ui/session', { credentials: 'same-origin' });
  });

  it('exposes only the primary single-user navigation', async () => {
    installApiMock();
    window.history.replaceState({}, '', '/content');

    render(<App />);

    const navigation = await screen.findByRole('navigation', { name: 'Primary' });
    expect([...navigation.querySelectorAll('a')].map((link) => link.textContent?.replace(/^\d+/, '')))
      .toEqual(['Content', 'Import', 'Tags', 'Libraries', 'Answers']);
  });
});
