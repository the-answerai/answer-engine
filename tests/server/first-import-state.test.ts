import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../src/config/database.js';
import {
  assertFirstImportTransition,
  reconcileFirstImportCounts,
} from '../../src/services/first-import/first-import-schemas.js';
import { FirstImportService } from '../../src/services/first-import/first-import-service.js';

describe('first import state', () => {
  it('does not allow importing to begin before explicit approval', () => {
    expect(() => assertFirstImportTransition('discovered', 'running')).toThrow(
      'Cannot move first import from discovered to running',
    );
    expect(() => assertFirstImportTransition('discovered', 'approved')).not.toThrow();
  });

  it('reconciles every discovered history into exactly one final outcome', () => {
    expect(reconcileFirstImportCounts({ imported: 4, duplicate: 2, failed: 1, skipped: 3 })).toEqual({
      discovered: 10,
      imported: 4,
      duplicate: 2,
      failed: 1,
      skipped: 3,
    });
  });

  it('does not revive a session canceled concurrently with start', async () => {
    const sessionId = randomUUID();
    let sessionReads = 0;
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM first_import_sessions WHERE')) {
        sessionReads += 1;
        return { rows: [{
          id: sessionId,
          status: sessionReads === 1 ? 'approved' : 'canceled',
          manifest_path: '/local/discovery.json',
          selected_source_ids: ['codex'],
          approved_at: '2026-08-14T12:00:00.000Z',
          started_at: null,
          completed_at: null,
          created_at: '2026-08-14T12:00:00.000Z',
          updated_at: '2026-08-14T12:00:00.000Z',
        }] };
      }
      if (sql.includes('FROM first_import_sources')) return { rows: [] };
      if (sql.includes('FROM first_import_items')) return { rows: [] };
      if (sql.includes("SET status='running'")) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected query: ${sql}`);
    });
    const service = new FirstImportService({ query } as unknown as Database);

    await expect(service.start({ tenantId: randomUUID(), apiKeyId: randomUUID() }, sessionId))
      .rejects.toThrow('Cannot start first import from canceled');
    expect(query.mock.calls.some(([sql]) => String(sql).includes('UPDATE first_import_sources'))).toBe(false);
  });
});
