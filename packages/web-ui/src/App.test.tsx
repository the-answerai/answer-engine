import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { WebAppExtensions } from './composition';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify({ success: true, data }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function healthResponse(channel: 'stable' | 'staging' = 'stable') {
  return new Response(JSON.stringify({ status: 'healthy', uptime: 1, channel }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function installApiMock() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url === '/local-ui/session') return new Response(null, { status: 204 });
    if (url === '/health') return healthResponse();
    if (url.startsWith('/api/v1/content')) return json([]);
    if (url.startsWith('/api/v1/tags')) return json([]);
    if (url.startsWith('/api/v1/libraries')) return json([]);
    if (url === '/api/v1/access-tokens') return json([]);
    if (url.startsWith('/api/v1/audit')) return json({ items: [], nextCursor: null, hasMore: false });
    if (url === '/api/v1/settings') return json({
      defaultPageSize: 25,
      defaultLibraryId: null,
      density: 'comfortable',
      defaultExportFormat: 'json',
    });
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
      .toEqual(['Content', 'Import', 'Tags', 'Libraries', 'Organize', 'Answers', 'Batch Jobs', 'Settings']);
  });

  it('renders a permanent staging indicator in desktop and mobile identity surfaces', async () => {
    const fetchMock = installApiMock();
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/local-ui/session') return new Response(null, { status: 204 });
      if (url === '/health') return healthResponse('staging');
      if (url.startsWith('/api/v1/content')) return json([]);
      if (url.startsWith('/api/v1/tags')) return json([]);
      if (url.startsWith('/api/v1/libraries')) return json([]);
      if (url === '/api/v1/settings') return json({ defaultPageSize: 25, defaultLibraryId: null, density: 'comfortable', defaultExportFormat: 'json' });
      return json([]);
    });

    render(<App />);

    expect((await screen.findByTestId('staging-sidebar-indicator')).textContent).toBe('STAGING');
    expect(screen.getByTestId('staging-mobile-indicator').textContent).toBe('STAGING');
  });

  it('keeps keyboard focus inside the open mobile navigation and restores the menu button', async () => {
    installApiMock();
    window.history.replaceState({}, '', '/content');
    const user = userEvent.setup();
    render(<App />);

    const menuButton = await screen.findByRole('button', { name: 'Open navigation' });
    await user.click(menuButton);
    const links = screen.getByRole('navigation', { name: 'Primary' }).querySelectorAll('a');
    expect(document.activeElement).toBe(links[0]);

    links[links.length - 1]?.focus();
    await user.tab();
    expect(document.activeElement).toBe(links[0]);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: 'Close navigation' })).toBeNull();
    expect(document.activeElement).toBe(menuButton);
  });

  it('applies saved density, page size, and library defaults to the workspace', async () => {
    const libraryId = crypto.randomUUID();
    window.history.replaceState({}, '', '/content');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/local-ui/session') return new Response(null, { status: 204 });
      if (url === '/health') return healthResponse();
      if (url === '/api/v1/settings') return json({
        defaultPageSize: 50,
        defaultLibraryId: libraryId,
        density: 'compact',
        defaultExportFormat: 'markdown',
      });
      if (url === '/api/v1/libraries') return json([{
        id: libraryId,
        name: 'Default decisions',
        kind: 'user_defined',
      }]);
      if (url.startsWith('/api/v1/content?')) return json([]);
      if (url === '/api/v1/tags') return json([]);
      return json({});
    });

    render(<App />);

    await waitFor(() => expect(document.querySelector('.shell')?.classList.contains('density-compact')).toBe(true));
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => {
      const url = String(input);
      return url.startsWith('/api/v1/content?')
        && url.includes('libraryId=')
        && url.includes('limit=50');
    })).toBe(true));
    expect((await screen.findByLabelText('Library') as HTMLSelectElement).value).toBe(libraryId);
  });

  it('composes a fixture identity, navigation route, policy, and settings panel without replacing core pages', async () => {
    installApiMock();
    window.history.replaceState({}, '', '/fixture-members');
    const extension = {
      capabilities: [{ id: 'fixture.members', label: 'Fixture members', family: 'teams' as const }],
      routes: [{
        id: 'fixture.members-route',
        path: '/fixture-members',
        capabilityId: 'fixture.members',
        element: <h1>Fixture members</h1>,
      }],
      navigation: [{
        id: 'fixture.members-nav',
        to: '/fixture-members',
        label: 'Members',
        mark: '08',
        capabilityId: 'fixture.members',
      }],
      settings: [{
        id: 'fixture.members-settings',
        title: 'Member settings',
        capabilityId: 'fixture.members',
        element: <p>Fixture member settings</p>,
      }],
      identity: {
        bootstrap: async () => ({ subject: 'fixture-user', label: 'Fixture owner', detail: 'Composed identity', workspaceLabel: 'COMPOSED WORKSPACE', shortLabel: 'SIGNED IN' }),
        render: (identity: { label: string; detail?: string }) => <div data-testid="fixture-identity">{identity.label}<small>{identity.detail}</small></div>,
      },
      authorization: { decide: () => ({ allowed: true }) },
    } satisfies WebAppExtensions;

    const { unmount } = render(<App extensions={extension} />);

    expect(await screen.findByRole('heading', { name: 'Fixture members' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Members/ })).toBeTruthy();
    expect(screen.getByTestId('fixture-identity').textContent).toBe('Fixture ownerComposed identity');
    expect(screen.getByText('COMPOSED WORKSPACE')).toBeTruthy();
    expect(screen.getByText('SIGNED IN')).toBeTruthy();

    unmount();
    window.history.replaceState({}, '', '/settings');
    render(<App extensions={extension} />);
    expect(await screen.findByText('Fixture member settings')).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeTruthy();
  });
});
