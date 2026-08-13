import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../src/config/database.js';
import type { LanguageProvider } from '../../src/services/ai/openai-compatible.js';
import { ContentService, QuerySchema } from '../../src/services/content/content-service.js';

describe('ContentService tenant boundaries', () => {
  it('binds full-text search to the authenticated tenant with parameterized input', async () => {
    const tenantId = randomUUID();
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const language: LanguageProvider = { embed: vi.fn(), complete: vi.fn() };
    const service = new ContentService({ query } as unknown as Database, language);
    const searchText = "memory'); DROP TABLE content_items; --";

    await service.query(
      { tenantId, apiKeyId: randomUUID() },
      QuerySchema.parse({ query: searchText, searchType: 'fulltext' }),
    );

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('c.tenant_id = $1');
    expect(sql).not.toContain(searchText);
    expect(params[0]).toBe(tenantId);
    expect(params).not.toContain(null);
    expect(params[1]).toBe(searchText);
  });

  it('does not call the embedding provider for deterministic full-text search', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const embed = vi.fn();
    const service = new ContentService(
      { query } as unknown as Database,
      { embed, complete: vi.fn() },
    );

    await service.query(
      { tenantId: randomUUID(), apiKeyId: randomUUID() },
      QuerySchema.parse({ query: 'local memory', searchType: 'fulltext' }),
    );

    expect(embed).not.toHaveBeenCalled();
  });

  it('enriches chat conversations while preserving raw provenance and canonical Cowork source', async () => {
    const tenantId = randomUUID();
    const libraryId = randomUUID();
    const contentId = randomUUID();
    const manifest = { manifest_path: '/local/archive/manifest.json', sha256: 'f'.repeat(64) };
    const databaseQuery = vi.fn().mockResolvedValue({
      rows: [{ id: libraryId, slug: 'personal-memory', name: 'Personal Memory', item_count: '0' }],
    });
    const clientQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: contentId }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const release = vi.fn();
    const validCompletion = {
      text: JSON.stringify({
        summary: 'A durable Cowork memory.',
        keywords: ['cowork', 'memory'],
        tags: ['local-history'],
        should_store: true,
        store_reason: 'Contains a durable implementation decision.',
        store_confidence: 0.98,
      }),
      model: 'local-chat',
      provider: 'lmstudio',
    };
    const complete = vi.fn()
      .mockResolvedValueOnce({
        text: '{"summary":"truncated',
        model: 'local-chat',
        provider: 'lmstudio',
      })
      .mockResolvedValueOnce(validCompletion);
    const service = new ContentService(
      { query: databaseQuery, connect: vi.fn().mockResolvedValue({ query: clientQuery, release }) } as unknown as Database,
      {
        embed: vi.fn().mockResolvedValue([0.1, 0.2]),
        complete,
      },
    );

    const result = await service.importContent(
      { tenantId, apiKeyId: randomUUID() },
      {
        items: [{
          title: 'Cowork memory', content: 'Preserve this exchange', content_type: 'chat',
          source_identifier: `cowork:${randomUUID()}`, source: 'cowork', source_agent_id: 'claude',
          raw_archive_manifest: manifest,
        }],
      },
    );

    expect(result.completedItems).toBe(1);
    expect(complete).toHaveBeenNthCalledWith(1, expect.objectContaining({
      maxTokens: 768,
      responseFormat: expect.objectContaining({ type: 'json_schema' }),
    }));
    expect(complete).toHaveBeenNthCalledWith(2, expect.objectContaining({
      maxTokens: 4096,
      responseFormat: expect.objectContaining({
        type: 'json_schema',
        json_schema: expect.objectContaining({
          schema: expect.objectContaining({
            properties: expect.objectContaining({
              summary: expect.objectContaining({ maxLength: 1000 }),
            }),
          }),
        }),
      }),
    }));
    const [, insertParams] = clientQuery.mock.calls[2] as [string, unknown[]];
    expect(insertParams[10]).toEqual(manifest);
    expect(insertParams[13]).toBe('cowork');
    expect(insertParams[19]).toBe('A durable Cowork memory.');
    expect(insertParams[20]).toBe('active');
    expect(insertParams[9]).toMatchObject({
      storeDecision: {
        shouldStore: true,
        reason: 'Contains a durable implementation decision.',
      },
      enrichment: {
        model: 'local-chat',
        provider: 'lmstudio',
      },
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it('archives low-value chat conversations while retaining their summary and raw record', async () => {
    const tenantId = randomUUID();
    const libraryId = randomUUID();
    const contentId = randomUUID();
    const databaseQuery = vi.fn().mockResolvedValue({
      rows: [{ id: libraryId, slug: 'personal-memory', name: 'Personal Memory', item_count: '0' }],
    });
    const clientQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: contentId }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const service = new ContentService(
      {
        query: databaseQuery,
        connect: vi.fn().mockResolvedValue({ query: clientQuery, release: vi.fn() }),
      } as unknown as Database,
      {
        embed: vi.fn().mockResolvedValue([0.1, 0.2]),
        complete: vi.fn().mockResolvedValue({
          text: JSON.stringify({
            summary: 'A brief acknowledgement.',
            keywords: [],
            tags: [],
            should_store: false,
            store_reason: 'Transient acknowledgement.',
            store_confidence: 0.95,
          }),
          model: 'local-chat',
          provider: 'lmstudio',
        }),
      },
    );

    const result = await service.importContent(
      { tenantId, apiKeyId: randomUUID() },
      {
        items: [{
          title: 'Acknowledgement',
          content: 'Thanks, done.',
          content_type: 'chat',
          source_identifier: `codex:${randomUUID()}`,
          source: 'codex',
        }],
      },
    );

    expect(result.completedItems).toBe(1);
    const [, insertParams] = clientQuery.mock.calls[2] as [string, unknown[]];
    expect(insertParams[19]).toBe('A brief acknowledgement.');
    expect(insertParams[20]).toBe('archived');
  });

  it('returns raw archive provenance from the lineage endpoint contract', async () => {
    const manifest = { manifest_path: '/local/archive/manifest.json', files: [{ sha256: 'a'.repeat(64) }] };
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ source: 'cowork', external_url: null, source_identifier: `cowork:${randomUUID()}`, raw_archive_manifest: manifest }] })
      .mockResolvedValueOnce({ rows: [] });
    const service = new ContentService(
      { query } as unknown as Database,
      { embed: vi.fn(), complete: vi.fn() },
    );

    const result = await service.lineage(
      { tenantId: randomUUID(), apiKeyId: randomUUID() },
      randomUUID(),
    );

    expect(result.origin.rawArchiveManifest).toEqual(manifest);
  });

  it('lists a lightweight summary projection without loading large lineage payloads', async () => {
    const contentId = randomUUID();
    const createdAt = new Date('2026-08-12T13:00:00.000Z');
    const query = vi.fn().mockResolvedValue({
      rows: [{
        id: contentId,
        content_type: 'chat',
        title: 'Cowork history',
        summary: 'A bounded summary.',
        primary_text_kind: 'raw_text',
        external_url: null,
        source_agent_id: 'cowork',
        conversation_id: 'cowork-session',
        turn_index: null,
        turn_role: null,
        turn_timestamp: null,
        turn_metadata: null,
        created_at: createdAt,
        updated_at: createdAt,
      }],
    });
    const service = new ContentService(
      { query } as unknown as Database,
      { embed: vi.fn(), complete: vi.fn() },
    );

    const result = await service.list(
      { tenantId: randomUUID(), apiKeyId: randomUUID() },
      { limit: 50 },
    );

    const [sql, parameters] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toContain('SELECT c.*');
    expect(sql).not.toContain('raw_archive_manifest');
    expect(parameters).not.toContain(null);
    expect(result.items[0]).toMatchObject({ id: contentId, summary: 'A bounded summary.' });
    expect(result.items[0]).not.toHaveProperty('content');
    expect(result.items[0]).not.toHaveProperty('metadata');
  });

  it('parameterizes workspace list filters and projects source status and tags', async () => {
    const tenantId = randomUUID();
    const contentId = randomUUID();
    const createdAt = new Date('2026-08-12T15:00:00.000Z');
    const query = vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          id: contentId,
          content_type: 'chat',
          source: 'codex',
          source_identifier: `codex:${randomUUID()}`,
          title: 'Filtered history',
          summary: 'A matching session.',
          status: 'active',
          tags: [{ id: randomUUID(), slug: 'shipping', label: 'Shipping', color: '#123456' }],
          primary_text_kind: 'raw_text',
          external_url: null,
          source_agent_id: 'codex',
          conversation_id: 'session-filtered',
          turn_index: null,
          turn_role: null,
          turn_timestamp: null,
          turn_metadata: null,
          created_at: createdAt,
          updated_at: createdAt,
        }],
      })
      .mockResolvedValue({ rows: [] });
    const service = new ContentService(
      { query } as unknown as Database,
      { embed: vi.fn(), complete: vi.fn() },
    );
    const search = "workspace'); DROP TABLE tags; --";

    const result = await service.list(
      { tenantId, apiKeyId: randomUUID() },
      {
        limit: 25,
        search,
        contentTypes: ['chat'],
        sources: ['claude-code', 'codex', 'cowork'],
        tags: ['shipping'],
        status: 'active',
        dateFrom: '2026-08-01T00:00:00.000Z',
        dateTo: '2026-08-31T23:59:59.000Z',
        sortBy: 'title',
        sortDirection: 'asc',
      },
    );

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('c.tenant_id = $1');
    expect(sql).toContain("websearch_to_tsquery('english'");
    expect(sql).toContain('c.content_type = ANY');
    expect(sql).toContain('t.slug = ANY');
    expect(sql).toContain('ORDER BY c.title ASC, c.id ASC');
    expect(sql).not.toContain(search);
    expect(params).toEqual(expect.arrayContaining([
      tenantId,
      search,
      ['chat'],
      ['claude-code', 'codex', 'cowork'],
      ['shipping'],
      'active',
    ]));
    expect(result.items[0]).toMatchObject({
      id: contentId,
      source: 'codex',
      status: 'active',
      tags: [expect.objectContaining({ slug: 'shipping' })],
    });
  });

  it('computes the filtered total before applying a page cursor', async () => {
    const contentId = randomUUID();
    const createdAt = new Date('2026-08-12T15:00:00.000Z');
    const cursor = Buffer.from(JSON.stringify([createdAt.toISOString(), contentId])).toString('base64url');
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const service = new ContentService(
      { query } as unknown as Database,
      { embed: vi.fn(), complete: vi.fn() },
    );

    await service.list(
      { tenantId: randomUUID(), apiKeyId: randomUUID() },
      { limit: 25, cursor },
    );

    const [sql] = query.mock.calls[0] as [string, unknown[]];
    const totalPosition = sql.indexOf('COUNT(*) OVER()');
    const cursorPosition = sql.indexOf('(c.created_at, c.id) <');
    expect(totalPosition).toBeGreaterThan(-1);
    expect(cursorPosition).toBeGreaterThan(totalPosition);
  });

  it('returns complete raw metadata and assigned tags from content detail', async () => {
    const contentId = randomUUID();
    const createdAt = new Date('2026-08-12T16:00:00.000Z');
    const rawArchiveManifest = { manifest_path: '/archive/codex/manifest.json' };
    const query = vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          id: contentId,
          tenant_id: randomUUID(),
          library_id: randomUUID(),
          content_type: 'chat',
          source: 'codex',
          source_identifier: `codex:${randomUUID()}`,
          title: 'Raw detail',
          content: 'Full conversation transcript',
          summary: 'Conversation summary',
          source_data: { sessionPath: '/local/codex/session.jsonl' },
          metadata: { project: 'answer-engine' },
          analysis_data: { keywords: ['local'] },
          raw_archive_manifest: rawArchiveManifest,
          external_url: null,
          primary_text_kind: 'raw_text',
          source_agent_id: 'codex',
          conversation_id: 'session-detail',
          turn_index: null,
          turn_role: null,
          turn_timestamp: null,
          turn_metadata: null,
          status: 'active',
          tags: [{ id: randomUUID(), slug: 'local', label: 'Local', color: null }],
          created_at: createdAt,
          updated_at: createdAt,
        }],
      })
      .mockResolvedValue({ rows: [] });
    const service = new ContentService(
      { query } as unknown as Database,
      { embed: vi.fn(), complete: vi.fn() },
    );

    const detail = await service.get(
      { tenantId: randomUUID(), apiKeyId: randomUUID() },
      contentId,
    );

    expect(detail).toMatchObject({
      source: 'codex',
      sourceIdentifier: expect.stringMatching(/^codex:/),
      status: 'active',
      sourceData: { sessionPath: '/local/codex/session.jsonl' },
      analysisData: { keywords: ['local'] },
      rawArchiveManifest,
      tags: [expect.objectContaining({ slug: 'local' })],
    });
  });
});
