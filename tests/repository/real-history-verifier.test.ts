import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  InstallerComposeDatabase,
  type RealHistoryDatabase,
  type RealHistoryRow,
  verifyRealHistory,
} from '../../scripts/verify-real-history.js';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const SOURCES = ['claude-code', 'codex', 'cowork'] as const;
const EXPECTED_INVENTORY = {
  'claude-code': 1,
  codex: 1,
  cowork: 1,
} as const;

const tempDirectories: string[] = [];

class FixtureDatabase implements RealHistoryDatabase {
  readonly queries: Array<{ text: string; values: readonly unknown[] }> = [];

  constructor(readonly rows: RealHistoryRow[]) {}

  async query<Row>(text: string, values: readonly unknown[]): Promise<{ rows: Row[] }> {
    this.queries.push({ text, values });
    if (text.includes('AS manifest_path')) {
      return {
        rows: this.rows.map((row) => {
          const manifest = row.raw_archive_manifest as Record<string, unknown> | null;
          return {
            id: row.id,
            source: row.source,
            source_identifier: row.source_identifier,
            summary: row.summary,
            manifest_path: typeof manifest?.manifest_path === 'string'
              ? manifest.manifest_path
              : null,
            manifest_valid: Array.isArray(manifest?.files) && manifest.files.length > 0,
          } as Row;
        }),
      };
    }
    return { rows: this.rows as unknown as Row[] };
  }
}

interface Fixture {
  database: FixtureDatabase;
  cursorFile: string;
  rows: RealHistoryRow[];
  syncSummaryFiles: string[];
  archiveFiles: Record<(typeof SOURCES)[number], string>;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'ae-real-history-'));
  tempDirectories.push(root);
  const cursorFile = join(root, 'sync-cursors.json');
  const rows: RealHistoryRow[] = [];
  const syncSummaryFiles: string[] = [];
  const archiveFiles = {} as Fixture['archiveFiles'];
  const cursorFiles: Record<string, Record<string, unknown>> = {};

  for (const [index, source] of SOURCES.entries()) {
    const archiveDirectory = join(root, `archive-${source}`);
    const filesDirectory = join(archiveDirectory, 'files');
    const archiveFile = join(filesDirectory, '000000-source.jsonl');
    const manifestPath = join(archiveDirectory, 'manifest.json');
    const archiveBytes = Buffer.from(`${source} fixture transcript`);
    const manifest = {
      version: 1,
      created_at: '2026-08-13T07:00:00.000Z',
      adapter_name: `${source}-adapter`,
      adapter_version: '1.0.0',
      files: [{
        path: `${source}-source.jsonl`,
        archive_path: 'files/000000-source.jsonl',
        size: archiveBytes.byteLength,
        mtime: '2026-08-13T07:00:00.000Z',
        sha256: createHash('sha256').update(archiveBytes).digest('hex'),
        adapter_name: `${source}-adapter`,
        adapter_version: '1.0.0',
      }],
    };

    await mkdir(filesDirectory, { recursive: true });
    await writeFile(archiveFile, archiveBytes);
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    archiveFiles[source] = archiveFile;
    rows.push({
      id: `history-${index}`,
      source,
      source_identifier: `${source}:conversation-${index}`,
      summary: `${source} summary`,
      raw_archive_manifest: { manifest_path: manifestPath, ...manifest },
    });

    cursorFiles[`${source}:${join(root, `${source}.jsonl`)}`] = {
      offset: archiveBytes.byteLength,
      line: 1,
      importedCount: 1,
      skippedCount: 0,
      fileSize: archiveBytes.byteLength,
      lastMtimeMs: 1,
      sourceSha256: manifest.files[0]?.sha256,
      updatedAt: '2026-08-13T07:00:00.000Z',
    };

    const syncSummaryFile = join(root, `sync-${source}.json`);
    await writeFile(syncSummaryFile, JSON.stringify({
      data: {
        sourceId: source,
        cursorFile,
        filesScanned: 1,
        turnsFound: 1,
        turnsImported: 1,
        failedItems: 0,
        parseErrors: 0,
      },
    }));
    syncSummaryFiles.push(syncSummaryFile);
  }

  await writeFile(cursorFile, JSON.stringify({ version: 1, files: cursorFiles }));
  return {
    database: new FixtureDatabase(rows),
    cursorFile,
    rows,
    syncSummaryFiles,
    archiveFiles,
  };
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('real history acceptance verifier', () => {
  it('passes a complete three-source inventory and scopes the database query by tenant', async () => {
    const fixture = await createFixture();

    const report = await verifyRealHistory({
      cursorFile: fixture.cursorFile,
      sampleSize: 1,
      syncSummaryFiles: fixture.syncSummaryFiles,
      tenantId: TENANT_ID,
    }, {
      database: fixture.database,
      expectedInventory: EXPECTED_INVENTORY,
    });

    expect(report.inventory).toEqual(EXPECTED_INVENTORY);
    expect(report.historyRows).toEqual({ 'claude-code': 1, codex: 1, cowork: 1 });
    expect(report.sampledArchives).toEqual({ 'claude-code': 1, codex: 1, cowork: 1 });
    expect(report.sampledFiles).toEqual({ 'claude-code': 1, codex: 1, cowork: 1 });
    expect(fixture.database.queries).toHaveLength(2);
    expect(fixture.database.queries[0]?.values).toEqual([TENANT_ID, SOURCES]);
    expect(fixture.database.queries[1]?.values).toEqual([
      TENANT_ID,
      ['history-0', 'history-1', 'history-2'],
    ]);
  });

  it('accepts recent zero-failure runs from the background service log', async () => {
    const fixture = await createFixture();
    const syncLogFile = join(tempDirectories.at(-1) as string, 'sync.out.log');
    await writeFile(syncLogFile, [
      '[2026-08-13T06:59:59.000Z] source=claude-code files=1 found=1 imported=1 failed=0 parseErrors=0',
      '[2026-08-13T07:00:00.000Z] source=claude-code files=1 found=0 imported=0 failed=0 parseErrors=0',
      '[2026-08-13T07:00:01.000Z] source=codex files=1 found=0 imported=0 failed=0 parseErrors=0',
      '[2026-08-13T07:00:02.000Z] source=cowork files=1 found=0 imported=0 failed=0 parseErrors=0',
    ].join('\n'));

    const report = await verifyRealHistory({
      cursorFile: fixture.cursorFile,
      sampleSize: 1,
      syncAfter: '2026-08-13T07:00:00.000Z',
      syncLogFile,
      syncSummaryFiles: [],
      tenantId: TENANT_ID,
    }, {
      database: fixture.database,
      expectedInventory: EXPECTED_INVENTORY,
    });

    expect(report.syncCompletedAt).toEqual({
      'claude-code': '2026-08-13T07:00:00.000Z',
      codex: '2026-08-13T07:00:01.000Z',
      cowork: '2026-08-13T07:00:02.000Z',
    });
  });

  it('queries the installer-managed database through its Compose project', async () => {
    const calls: Array<{ command: string; args: readonly string[]; input: string }> = [];
    const row = {
      id: 'history-1',
      source: 'codex',
      source_identifier: 'codex:history-1',
      summary: 'summary',
      raw_archive_manifest: null,
    };
    const database = new InstallerComposeDatabase('/tmp/installer-home', async (
      command,
      args,
      input,
    ) => {
      calls.push({ command, args, input });
      return { status: 0, stdout: JSON.stringify(row), stderr: '' };
    }, 'answer-engine-test');

    const result = await database.query<unknown>(
      'SELECT * FROM content_items WHERE tenant_id = $1 AND source = ANY($2::text[])',
      [TENANT_ID, SOURCES],
    );

    expect(result.rows).toEqual([row]);
    expect(calls[0]?.command).toBe('docker');
    expect(calls[0]?.args).toContain('/tmp/installer-home/docker-compose.yml');
    expect(calls[0]?.args).toContain('answer-engine-test');
    expect(calls[0]?.args).toContain(`tenant_id=${TENANT_ID}`);
    expect(calls[0]?.input).toContain("tenant_id = :'tenant_id'::uuid");
    expect(calls[0]?.input).toContain("string_to_array(:'sources', ',')::text[]");
  });

  it('rejects an incomplete cursor inventory', async () => {
    const fixture = await createFixture();
    const cursor = JSON.parse(await readFile(fixture.cursorFile, 'utf8')) as {
      files: Record<string, unknown>;
    };
    const coworkKey = Object.keys(cursor.files).find((key) => key.startsWith('cowork:'));
    if (coworkKey) delete cursor.files[coworkKey];
    await writeFile(fixture.cursorFile, JSON.stringify(cursor));

    await expect(verifyRealHistory({
      cursorFile: fixture.cursorFile,
      sampleSize: 1,
      syncSummaryFiles: fixture.syncSummaryFiles,
      tenantId: TENANT_ID,
    }, {
      database: fixture.database,
      expectedInventory: EXPECTED_INVENTORY,
    })).rejects.toThrow('cowork cursor inventory: expected at least 1, found 0');
  });

  it('does not count stale cursor entries as currently discovered files', async () => {
    const fixture = await createFixture();
    const cursor = JSON.parse(await readFile(fixture.cursorFile, 'utf8')) as {
      files: Record<string, Record<string, unknown>>;
    };
    const firstClaudeCursor = Object.entries(cursor.files)
      .find(([key]) => key.startsWith('claude-code:'))?.[1];
    if (!firstClaudeCursor) throw new Error('Claude cursor fixture is missing');
    cursor.files['claude-code:/deleted-session.jsonl'] = { ...firstClaudeCursor };
    await writeFile(fixture.cursorFile, JSON.stringify(cursor));

    const report = await verifyRealHistory({
      cursorFile: fixture.cursorFile,
      sampleSize: 1,
      syncSummaryFiles: fixture.syncSummaryFiles,
      tenantId: TENANT_ID,
    }, {
      database: fixture.database,
      expectedInventory: EXPECTED_INVENTORY,
    });

    expect(report.inventory['claude-code']).toBe(1);
  });

  it('accepts append-only source growth above the required baseline', async () => {
    const fixture = await createFixture();
    const cursor = JSON.parse(await readFile(fixture.cursorFile, 'utf8')) as {
      files: Record<string, Record<string, unknown>>;
    };
    const firstClaudeCursor = Object.entries(cursor.files)
      .find(([key]) => key.startsWith('claude-code:'))?.[1];
    if (!firstClaudeCursor) throw new Error('Claude cursor fixture is missing');
    cursor.files['claude-code:/new-session.jsonl'] = { ...firstClaudeCursor };
    await writeFile(fixture.cursorFile, JSON.stringify(cursor));
    const claudeSummaryPath = fixture.syncSummaryFiles[0] as string;
    const summary = JSON.parse(await readFile(claudeSummaryPath, 'utf8')) as {
      data: Record<string, unknown>;
    };
    summary.data.filesScanned = 2;
    await writeFile(claudeSummaryPath, JSON.stringify(summary));

    const report = await verifyRealHistory({
      cursorFile: fixture.cursorFile,
      sampleSize: 1,
      syncSummaryFiles: fixture.syncSummaryFiles,
      tenantId: TENANT_ID,
    }, {
      database: fixture.database,
      expectedInventory: EXPECTED_INVENTORY,
    });

    expect(report.inventory['claude-code']).toBe(2);
  });

  it('rejects cursor inventory entries with accumulated parse skips', async () => {
    const fixture = await createFixture();
    const cursor = JSON.parse(await readFile(fixture.cursorFile, 'utf8')) as {
      files: Record<string, Record<string, unknown>>;
    };
    const codexKey = Object.keys(cursor.files).find((key) => key.startsWith('codex:'));
    if (codexKey) cursor.files[codexKey] = { ...cursor.files[codexKey], skippedCount: 1 };
    await writeFile(fixture.cursorFile, JSON.stringify(cursor));

    await expect(verifyRealHistory({
      cursorFile: fixture.cursorFile,
      sampleSize: 1,
      syncSummaryFiles: fixture.syncSummaryFiles,
      tenantId: TENANT_ID,
    }, {
      database: fixture.database,
      expectedInventory: EXPECTED_INVENTORY,
    })).rejects.toThrow('codex cursor inventory reports 1 skipped item');
  });

  it('rejects history rows without summaries', async () => {
    const fixture = await createFixture();
    const first = fixture.rows[0] as RealHistoryRow;
    fixture.rows[0] = { ...first, summary: '   ' };

    await expect(verifyRealHistory({
      cursorFile: fixture.cursorFile,
      sampleSize: 1,
      syncSummaryFiles: fixture.syncSummaryFiles,
      tenantId: TENANT_ID,
    }, {
      database: fixture.database,
      expectedInventory: EXPECTED_INVENTORY,
    })).rejects.toThrow('history rows are missing summaries');
  });

  it('rejects history rows without raw archive manifests', async () => {
    const fixture = await createFixture();
    const first = fixture.rows[0] as RealHistoryRow;
    fixture.rows[0] = { ...first, raw_archive_manifest: null };

    await expect(verifyRealHistory({
      cursorFile: fixture.cursorFile,
      sampleSize: 1,
      syncSummaryFiles: fixture.syncSummaryFiles,
      tenantId: TENANT_ID,
    }, {
      database: fixture.database,
      expectedInventory: EXPECTED_INVENTORY,
    })).rejects.toThrow('history rows are missing raw archive manifests');
  });

  it('rejects malformed raw archive manifests', async () => {
    const fixture = await createFixture();
    const first = fixture.rows[0] as RealHistoryRow;
    fixture.rows[0] = {
      ...first,
      raw_archive_manifest: { ...first.raw_archive_manifest, version: 2 },
    };

    await expect(verifyRealHistory({
      cursorFile: fixture.cursorFile,
      sampleSize: 1,
      syncSummaryFiles: fixture.syncSummaryFiles,
      tenantId: TENANT_ID,
    }, {
      database: fixture.database,
      expectedInventory: EXPECTED_INVENTORY,
    })).rejects.toThrow('history row has a malformed raw archive manifest');
  });

  it('rejects sampled archive bytes that do not match SHA-256', async () => {
    const fixture = await createFixture();
    await writeFile(fixture.archiveFiles.codex, 'tampered transcript');

    await expect(verifyRealHistory({
      cursorFile: fixture.cursorFile,
      sampleSize: 1,
      syncSummaryFiles: fixture.syncSummaryFiles,
      tenantId: TENANT_ID,
    }, {
      database: fixture.database,
      expectedInventory: EXPECTED_INVENTORY,
    })).rejects.toThrow('codex sampled archive SHA-256 mismatch');
  });

  it('rejects a source with fewer unique archives than the requested sample size', async () => {
    const fixture = await createFixture();

    await expect(verifyRealHistory({
      cursorFile: fixture.cursorFile,
      sampleSize: 2,
      syncSummaryFiles: fixture.syncSummaryFiles,
      tenantId: TENANT_ID,
    }, {
      database: fixture.database,
      expectedInventory: EXPECTED_INVENTORY,
    })).rejects.toThrow('claude-code archive sample: expected 2, found 1');
  });

  it.each(['failedItems', 'parseErrors'] as const)(
    'rejects a sync summary with non-zero %s',
    async (field) => {
      const fixture = await createFixture();
      const summaryPath = fixture.syncSummaryFiles[0] as string;
      const summary = JSON.parse(await readFile(summaryPath, 'utf8')) as {
        data: Record<string, unknown>;
      };
      summary.data[field] = 1;
      await writeFile(summaryPath, JSON.stringify(summary));

      await expect(verifyRealHistory({
        cursorFile: fixture.cursorFile,
        sampleSize: 1,
        syncSummaryFiles: fixture.syncSummaryFiles,
        tenantId: TENANT_ID,
      }, {
        database: fixture.database,
        expectedInventory: EXPECTED_INVENTORY,
      })).rejects.toThrow('sync summary reports failures');
    },
  );

  it('rejects sync evidence produced against a different cursor inventory', async () => {
    const fixture = await createFixture();
    const summaryPath = fixture.syncSummaryFiles[0] as string;
    const summary = JSON.parse(await readFile(summaryPath, 'utf8')) as {
      data: Record<string, unknown>;
    };
    summary.data.cursorFile = join(tmpdir(), 'different-sync-cursors.json');
    await writeFile(summaryPath, JSON.stringify(summary));

    await expect(verifyRealHistory({
      cursorFile: fixture.cursorFile,
      sampleSize: 1,
      syncSummaryFiles: fixture.syncSummaryFiles,
      tenantId: TENANT_ID,
    }, {
      database: fixture.database,
      expectedInventory: EXPECTED_INVENTORY,
    })).rejects.toThrow('sync summary references a different cursor inventory');
  });

  it('validates the tenant identifier before querying stored history', async () => {
    const fixture = await createFixture();

    await expect(verifyRealHistory({
      cursorFile: fixture.cursorFile,
      sampleSize: 1,
      syncSummaryFiles: fixture.syncSummaryFiles,
      tenantId: 'not-a-tenant-id',
    }, {
      database: fixture.database,
      expectedInventory: EXPECTED_INVENTORY,
    })).rejects.toThrow('Invalid uuid');
    expect(fixture.database.queries).toHaveLength(0);
  });
});
