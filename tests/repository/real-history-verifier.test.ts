import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
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
    expect(fixture.database.queries).toHaveLength(1);
    expect(fixture.database.queries[0]?.values).toEqual([TENANT_ID, SOURCES]);
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
    })).rejects.toThrow('cowork inventory: expected 1, found 0');
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
