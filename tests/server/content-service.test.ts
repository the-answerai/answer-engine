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
    expect(params[2]).toBe(searchText);
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

  it('projects raw archive provenance and the canonical Cowork source into content storage', async () => {
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
    const service = new ContentService(
      { query: databaseQuery, connect: vi.fn().mockResolvedValue({ query: clientQuery, release }) } as unknown as Database,
      { embed: vi.fn().mockRejectedValue(new Error('embedding disabled')), complete: vi.fn() },
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
    const [, insertParams] = clientQuery.mock.calls[2] as [string, unknown[]];
    expect(insertParams[10]).toEqual(manifest);
    expect(insertParams[13]).toBe('cowork');
    expect(release).toHaveBeenCalledOnce();
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
});
