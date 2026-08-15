import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { FolderSource, OrganizationPlan } from './types';

const contentId = '11111111-1111-4111-8111-111111111111';

function json(data: unknown, meta?: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify({ success: true, data, ...(meta ? { meta } : {}) }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function healthResponse() {
  return new Response(JSON.stringify({ status: 'healthy', uptime: 1, channel: 'stable' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('primary local workflows', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(cleanup);

  it('requires a decision for every organization suggestion and supports audited undo', async () => {
    window.history.replaceState({}, '', '/organize');
    const planId = '99999999-9999-4999-8999-999999999999';
    const tagSuggestionId = 's-1111111111111111';
    const assignSuggestionId = 's-2222222222222222';
    const preview: OrganizationPlan = {
      id: planId, status: 'preview', proposalMode: 'local', sampleLimit: 50, sampleCount: 2,
      sourceSnapshotSha256: 'a'.repeat(64), proposalSha256: 'b'.repeat(64),
      suggestions: [
        {
          id: tagSuggestionId, type: 'tag.create', confidence: 1, rationale: 'Both records came from Codex.',
          evidence: [{ contentId, title: 'Codex decision', source: 'codex' }], dependsOn: [],
          tag: { slug: 'codex', label: 'Codex', description: 'Codex memory', category: 'Suggested', color: '#1B3A8F' },
        },
        {
          id: assignSuggestionId, type: 'tag.assign', confidence: 1, rationale: 'Assign only supported records.',
          evidence: [{ contentId, title: 'Codex decision', source: 'codex' }], dependsOn: [tagSuggestionId],
          tagSlug: 'codex', contentIds: [contentId],
        },
      ],
      decisions: null, applyResult: null, modelProvider: null, modelId: null,
      appliedAt: null, undoneAt: null,
      createdAt: '2026-08-15T20:00:00.000Z', updatedAt: '2026-08-15T20:00:00.000Z',
    };
    let current: OrganizationPlan | undefined;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/local-ui/session') return new Response(null, { status: 204 });
      if (url === '/health') return healthResponse();
      if (url === '/api/v1/settings') return json({ defaultPageSize: 25, defaultLibraryId: null, density: 'comfortable', defaultExportFormat: 'json' });
      if (url === '/api/v1/organization-plans' && init?.method === 'POST') { current = preview; return json(current, undefined, 201); }
      if (url === '/api/v1/organization-plans') return json(current ? [current] : []);
      if (url.endsWith('/apply') && init?.method === 'POST') {
        const decisions = (JSON.parse(String(init.body)) as { decisions: unknown[] }).decisions;
        current = { ...preview, status: 'applied', decisions: decisions as OrganizationPlan['decisions'], appliedAt: '2026-08-15T20:01:00.000Z' };
        return json(current);
      }
      if (url.endsWith('/undo') && init?.method === 'POST') {
        current = { ...current!, status: 'undone', undoneAt: '2026-08-15T20:02:00.000Z' };
        return json(current);
      }
      return json([]);
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Create proposal' }));
    expect(await screen.findByText('Create tag “Codex”')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Apply reviewed plan' }) as HTMLButtonElement).disabled).toBe(true);
    for (const accept of screen.getAllByLabelText('Accept')) await user.click(accept);
    await user.click(screen.getByRole('button', { name: 'Apply reviewed plan' }));

    expect(await screen.findByText(/Applied with an audit record/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/organization-plans/${planId}/apply`,
      expect.objectContaining({ body: expect.stringContaining(assignSuggestionId) }),
    );
    await user.click(screen.getByRole('button', { name: 'Undo this plan' }));
    await user.click(await screen.findByRole('button', { name: 'Undo plan' }));
    expect(await screen.findByText(/Undo completed/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Reapply reviewed plan' }));
    expect(await screen.findByText(/Applied with an audit record/)).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith('/apply') && init?.method === 'POST')).toHaveLength(2);
  });

  it('asks a grounded question and opens the cited content inspector', async () => {
    window.history.replaceState({}, '', '/answers');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/local-ui/session') return new Response(null, { status: 204 });
      if (url === '/health') return healthResponse();
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
      if (url === '/health') return healthResponse();
      if (url === '/api/v1/libraries') return json([]);
      if (url === '/api/v1/content/import/preview') return json({ format: 'json', rowCount: 1, sample: [{ title: 'Local decision', content: 'Preserve this.', contentType: 'document', source: 'local-ui' }], parseErrors: [] });
      if (url === '/api/v1/content/import' && init?.method === 'POST') return json({ completedItems: 1, failedItems: 0, items: [{ rowIndex: 0, id: contentId, contentType: 'document', sourceIdentifier: 'local-ui:test', title: 'Local decision' }], failures: [] }, undefined, 201);
      return json([]);
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Manual text' }));
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
      if (url === '/health') return healthResponse();
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

    await user.click(await screen.findByRole('button', { name: 'Manual text' }));
    await user.type(await screen.findByLabelText('Title'), 'Duplicate decision');
    await user.type(screen.getByLabelText('Content'), 'Preserve this.');
    await user.click(screen.getByRole('button', { name: 'Preview import' }));
    await user.click(await screen.findByRole('button', { name: 'Import 1 item' }));

    expect((await screen.findByRole('alert')).textContent).toContain('The destination library is no longer available.');
    expect(screen.getByRole('button', { name: 'Import 1 item' })).toBeTruthy();
  });

  it('requires explicit consent and sends only the selected agent-history sources', async () => {
    window.history.replaceState({}, '', '/import');
    const session = {
      id: '33333333-3333-4333-8333-333333333333', status: 'discovered',
      selectedSourceIds: [], approvedAt: null, pending: 3,
      counts: { discovered: 0, imported: 0, duplicate: 0, failed: 0, skipped: 0 },
      sources: [
        { sourceId: 'claude-code', label: 'Claude Code', paths: ['/Users/local/.claude/projects'], estimatedCount: 2, estimatedBytes: 2048, privacyPosture: 'Transcript bodies are read only after approval.', exclusions: ['audit logs'], availability: 'available', availabilityNote: 'Local source history is available for selection.', status: 'discovered', errorCode: null, recoveryAction: null },
        { sourceId: 'codex', label: 'Codex', paths: ['/Users/local/.codex/sessions'], estimatedCount: 1, estimatedBytes: 1024, privacyPosture: 'Rollout bodies are read only after approval.', exclusions: ['prompt history'], availability: 'available', availabilityNote: 'Local source history is available for selection.', status: 'discovered', errorCode: null, recoveryAction: null },
      ],
      items: [],
    };
    let approved = false;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/local-ui/session') return new Response(null, { status: 204 });
      if (url === '/health') return healthResponse();
      if (url === '/api/v1/libraries') return json([]);
      if (url === '/api/v1/first-imports/latest') return json(approved ? {
        ...session, status: 'approved', approvedAt: '2026-08-14T12:00:00.000Z', selectedSourceIds: ['codex'],
      } : session);
      if (url.endsWith('/approve') && init?.method === 'POST') {
        approved = true;
        return json({
          ...session, status: 'approved', approvedAt: '2026-08-14T12:00:00.000Z', selectedSourceIds: ['codex'],
        });
      }
      return json([]);
    });
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByText('Transcript bodies are read only after approval.')).toBeTruthy();
    await user.click(screen.getByLabelText('Claude Code'));
    await user.click(screen.getByLabelText('I understand what Answer Engine will read'));
    await user.click(screen.getByRole('button', { name: 'Approve 1 source' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/first-imports/${session.id}/approve`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ sourceIds: ['codex'] }) }),
    ));
    await waitFor(() => expect((screen.getByLabelText('Codex') as HTMLInputElement).checked).toBe(true));
    expect((screen.getByLabelText('Claude Code') as HTMLInputElement).checked).toBe(false);
  });

  it('filters content with array-backed facets and ISO date boundaries', async () => {
    window.history.replaceState({}, '', '/content');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/local-ui/session') return new Response(null, { status: 204 });
      if (url === '/health') return healthResponse();
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

  it('queues bulk work only for the content selected in the workspace', async () => {
    window.history.replaceState({}, '', '/content');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/local-ui/session') return new Response(null, { status: 204 });
      if (url === '/health') return healthResponse();
      if (url === '/api/v1/tags' || url === '/api/v1/libraries') return json([]);
      if (url.startsWith('/api/v1/content?')) return json([{
        id: contentId,
        title: 'Selected decision',
        contentType: 'document',
        source: 'codex',
        status: 'active',
        tags: [],
        createdAt: '2026-08-12T00:00:00.000Z',
        updatedAt: '2026-08-12T00:00:00.000Z',
      }], { hasMore: false, nextCursor: null, total: 1 });
      if (url === '/api/v1/batch-jobs' && init?.method === 'POST') {
        return json({ id: crypto.randomUUID(), status: 'queued' }, undefined, 202);
      }
      return json([]);
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByLabelText('Select Selected decision'));
    await user.click(screen.getByRole('button', { name: 'Batch' }));
    await user.type(screen.getByLabelText('Name'), 'Selected decision batch');
    await user.type(screen.getByLabelText('Prompt'), 'Summarize the decision.');
    await user.click(screen.getByRole('button', { name: 'Queue job' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/batch-jobs',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining(`"contentIds":["${contentId}"]`),
      }),
    ));
  });

  it('requires consent for an exact folder preview and an explicit removal retention choice', async () => {
    window.history.replaceState({}, '', '/import');
    const runId = '44444444-4444-4444-8444-444444444444';
    const sourceId = '55555555-5555-4555-8555-555555555555';
    const source: FolderSource = {
      id: sourceId, libraryId: null, rootPath: '/Users/local/Documents/notes',
      includePatterns: ['**/*.md'], excludePatterns: ['private/**'], maxFileBytes: 5_242_880,
      maxTotalBytes: 104_857_600, symlinkPolicy: 'no_follow', manifestPath: '/channel/preview.json',
      status: 'previewed', retention: null, approvedAt: null, removedAt: null, runs: [],
      latestRun: {
        id: runId, sourceId, kind: 'initial', status: 'previewed', manifestPath: '/channel/preview.json',
        approvedAt: null, inventoryCounts: { total: 2, candidate: 1, symlink: 1, bytes: 12 },
        counts: { previewed: 2, pending: 1, imported: 0, updated: 0, duplicate: 0, excluded: 1, changed: 0, failed: 0, skipped: 0, missing: 0 },
        items: [
          { sourcePath: '/Users/local/Documents/notes/decision.md', relativePath: 'decision.md', fileType: '.md', byteSize: 12, modifiedAt: '2026-08-15T12:00:00.000Z', disposition: 'candidate', reason: 'Supported text file within configured limits', change: 'added', metadataFingerprint: 'a'.repeat(64), outcome: 'pending', appliedSha256: null, contentId: null, archiveManifestPath: null, errorCode: null, recoveryAction: null },
          { sourcePath: '/Users/local/Documents/notes/latest.md', relativePath: 'latest.md', fileType: null, byteSize: 0, modifiedAt: null, disposition: 'symlink', reason: 'Symlinks are never followed', change: null, metadataFingerprint: null, outcome: 'excluded', appliedSha256: null, contentId: null, archiveManifestPath: null, errorCode: null, recoveryAction: null },
        ],
      },
    };
    source.runs = [source.latestRun!];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/local-ui/session') return new Response(null, { status: 204 });
      if (url === '/health') return healthResponse();
      if (url === '/api/v1/libraries') return json([]);
      if (url === '/api/v1/first-imports/latest') return json(null);
      if (url === '/api/v1/folder-sources/latest') return json(source);
      if (url.endsWith(`/runs/${runId}/approve`) && init?.method === 'POST') return json(source);
      if (url.endsWith(`/${sourceId}/remove`) && init?.method === 'POST') return json({ ...source, status: 'removal_pending', retention: 'delete' });
      return json([]);
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Local folder' }));
    expect(await screen.findByText('/Users/local/Documents/notes')).toBeTruthy();
    const approve = screen.getByRole('button', { name: 'Approve 1 document' });
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Cancel preview' })).toBeTruthy();
    await user.click(screen.getByLabelText('I approve this exact folder root, inventory, and safety policy'));
    await user.click(approve);
    await user.click(screen.getByText('Remove this folder source'));
    await user.click(screen.getByLabelText('Delete mapped memories and source-owned archives'));
    expect((screen.getByRole('button', { name: 'Prepare delete removal' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByLabelText('I understand this choice will be recorded in the local audit log'));
    await user.click(screen.getByRole('button', { name: 'Prepare delete removal' }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(`/api/v1/folder-sources/runs/${runId}/approve`, expect.objectContaining({ method: 'POST' }));
      expect(fetchMock).toHaveBeenCalledWith(`/api/v1/folder-sources/${sourceId}/remove`, expect.objectContaining({ body: '{"retention":"delete"}' }));
    });
  });
});
