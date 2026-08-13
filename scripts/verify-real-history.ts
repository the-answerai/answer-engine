import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  RawArchiveManifestSchema,
} from '../packages/cli/src/sync/raw-archive.js';
import { syncCursorFilePath } from '../packages/cli/src/home.js';
import { createDatabasePool } from './database.js';

const TRANSCRIPT_SOURCES = ['claude-code', 'codex', 'cowork'] as const;
const TranscriptSourceSchema = z.enum(TRANSCRIPT_SOURCES);
type TranscriptSource = z.infer<typeof TranscriptSourceSchema>;

export const EXPECTED_REAL_HISTORY_INVENTORY = {
  'claude-code': 848,
  codex: 4_105,
  cowork: 112,
} as const satisfies Record<TranscriptSource, number>;

const NonEmptyStringSchema = z.string().trim().min(1);
const CursorSchema = z.object({
  offset: z.number().int().nonnegative(),
  line: z.number().int().nonnegative(),
  importedCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
  fileSize: z.number().int().nonnegative(),
  lastMtimeMs: z.number().nonnegative(),
  fileIdentity: z.string().optional(),
  sourceSha256: z.string().optional(),
  lastImportedSourceIdentifier: z.string().optional(),
  contentId: z.string().optional(),
  updatedAt: z.string().datetime().optional(),
}).strict();
const CursorInventorySchema = z.object({
  version: z.literal(1),
  files: z.record(CursorSchema),
}).strict();

const SyncRunSummarySchema = z.object({
  sourceId: TranscriptSourceSchema,
  cursorFile: NonEmptyStringSchema,
  filesScanned: z.number().int().nonnegative(),
  turnsFound: z.number().int().nonnegative(),
  turnsImported: z.number().int().nonnegative(),
  failedItems: z.number().int().nonnegative(),
  parseErrors: z.number().int().nonnegative(),
}).strict();
const SyncSummaryDocumentSchema = z.preprocess((input) => {
  if (input !== null && typeof input === 'object' && !Array.isArray(input) && 'data' in input) {
    return (input as Record<string, unknown>).data;
  }
  return input;
}, SyncRunSummarySchema);

const StoredRawArchiveManifestSchema = RawArchiveManifestSchema.extend({
  manifest_path: NonEmptyStringSchema,
});

const RealHistoryRowSchema = z.object({
  id: NonEmptyStringSchema,
  source: TranscriptSourceSchema,
  source_identifier: NonEmptyStringSchema,
  summary: z.string().nullable(),
  raw_archive_manifest: z.unknown().nullable(),
}).strict();

export type RealHistoryRow = z.infer<typeof RealHistoryRowSchema>;

export interface RealHistoryDatabase {
  query<Row>(text: string, values: unknown[]): Promise<{ rows: Row[] }>;
}

export interface RealHistoryVerificationOptions {
  tenantId: string;
  cursorFile: string;
  syncSummaryFiles: string[];
  sampleSize: number;
}

interface RealHistoryVerificationDependencies {
  database: RealHistoryDatabase;
  expectedInventory?: Readonly<Record<TranscriptSource, number>>;
}

export interface RealHistoryVerificationReport {
  inventory: Record<TranscriptSource, number>;
  historyRows: Record<TranscriptSource, number>;
  validatedManifests: Record<TranscriptSource, number>;
  sampledArchives: Record<TranscriptSource, number>;
  sampledFiles: Record<TranscriptSource, number>;
  syncRuns: Record<TranscriptSource, number>;
}

export class RealHistoryVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RealHistoryVerificationError';
  }
}

const RealHistoryVerificationOptionsSchema = z.object({
  tenantId: z.string().uuid(),
  cursorFile: NonEmptyStringSchema,
  syncSummaryFiles: z.array(NonEmptyStringSchema).min(1),
  sampleSize: z.number().int().positive().max(100),
}).strict();

function emptySourceCounts(): Record<TranscriptSource, number> {
  return { 'claude-code': 0, codex: 0, cowork: 0 };
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

async function readBytes(path: string, label: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch {
    throw new RealHistoryVerificationError(`${label} could not be read`);
  }
}

async function readJson(path: string, label: string): Promise<unknown> {
  const bytes = await readBytes(path, label);
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new RealHistoryVerificationError(`${label} is not valid JSON`);
  }
}

function parseDocument<Output>(
  schema: z.ZodType<Output, z.ZodTypeDef, unknown>,
  input: unknown,
  label: string,
): Output {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new RealHistoryVerificationError(
      `${label} failed schema validation: ${formatZodIssues(result.error)}`,
    );
  }
  return result.data;
}

function inventorySource(key: string): TranscriptSource | undefined {
  return TRANSCRIPT_SOURCES.find((source) => key.startsWith(`${source}:`));
}

async function verifyInventory(
  cursorFile: string,
  expected: Readonly<Record<TranscriptSource, number>>,
): Promise<Record<TranscriptSource, number>> {
  const inventory = parseDocument(
    CursorInventorySchema,
    await readJson(cursorFile, 'sync cursor inventory'),
    'sync cursor inventory',
  );
  const counts = emptySourceCounts();
  for (const key of Object.keys(inventory.files)) {
    const source = inventorySource(key);
    if (source) counts[source] += 1;
  }
  for (const source of TRANSCRIPT_SOURCES) {
    if (counts[source] !== expected[source]) {
      throw new RealHistoryVerificationError(
        `${source} inventory: expected ${expected[source]}, found ${counts[source]}`,
      );
    }
  }
  return counts;
}

async function verifySyncSummaries(
  files: readonly string[],
  cursorFile: string,
  expected: Readonly<Record<TranscriptSource, number>>,
): Promise<Record<TranscriptSource, number>> {
  const counts = emptySourceCounts();
  for (const file of files) {
    const summary = parseDocument<z.infer<typeof SyncRunSummarySchema>>(
      SyncSummaryDocumentSchema,
      await readJson(file, 'sync summary'),
      'sync summary',
    );
    counts[summary.sourceId] += 1;
    if (resolve(summary.cursorFile) !== resolve(cursorFile)) {
      throw new RealHistoryVerificationError(
        `${summary.sourceId} sync summary references a different cursor inventory`,
      );
    }
    if (summary.failedItems > 0 || summary.parseErrors > 0) {
      throw new RealHistoryVerificationError(
        `${summary.sourceId} sync summary reports failures: `
        + `${summary.failedItems} failed items, ${summary.parseErrors} parse errors`,
      );
    }
    if (summary.filesScanned !== expected[summary.sourceId]) {
      throw new RealHistoryVerificationError(
        `${summary.sourceId} sync scan: expected ${expected[summary.sourceId]} files, `
        + `found ${summary.filesScanned}`,
      );
    }
  }
  for (const source of TRANSCRIPT_SOURCES) {
    if (counts[source] !== 1) {
      throw new RealHistoryVerificationError(
        `${source} requires exactly one successful sync summary; found ${counts[source]}`,
      );
    }
  }
  return counts;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => (
      `${JSON.stringify(key)}:${canonicalJson(entry)}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function archiveFilePath(manifestPath: string, archivePath: string): string {
  const base = dirname(manifestPath);
  const candidate = resolve(base, archivePath);
  const child = relative(base, candidate);
  if (isAbsolute(archivePath) || child.startsWith('..') || isAbsolute(child)) {
    throw new RealHistoryVerificationError('raw archive manifest contains an unsafe archive path');
  }
  return candidate;
}

function sampleScore(row: RealHistoryRow): string {
  return createHash('sha256')
    .update(`${row.source}\0${row.source_identifier}\0${row.id}`)
    .digest('hex');
}

interface ValidatedHistoryRow extends RealHistoryRow {
  manifest: z.infer<typeof StoredRawArchiveManifestSchema>;
}

function validateRows(rows: unknown[]): ValidatedHistoryRow[] {
  const parsedRows = rows.map((row) => parseDocument(
    RealHistoryRowSchema,
    row,
    'database history row',
  ));
  const missingSummaries = parsedRows.filter((row) => !row.summary?.trim());
  if (missingSummaries.length > 0) {
    throw new RealHistoryVerificationError(
      `${missingSummaries.length} history rows are missing summaries`,
    );
  }
  const missingManifests = parsedRows.filter((row) => row.raw_archive_manifest === null);
  if (missingManifests.length > 0) {
    throw new RealHistoryVerificationError(
      `${missingManifests.length} history rows are missing raw archive manifests`,
    );
  }

  return parsedRows.map((row) => {
    const result = StoredRawArchiveManifestSchema.safeParse(row.raw_archive_manifest);
    if (!result.success || result.data.files.length === 0) {
      const detail = result.success
        ? 'files: must contain at least one archived file'
        : formatZodIssues(result.error);
      throw new RealHistoryVerificationError(
        `history row has a malformed raw archive manifest: ${detail}`,
      );
    }
    return { ...row, manifest: result.data };
  });
}

async function verifySampledManifest(row: ValidatedHistoryRow): Promise<number> {
  const { manifest_path: manifestPath, ...storedManifest } = row.manifest;
  const diskManifest = parseDocument(
    RawArchiveManifestSchema,
    await readJson(manifestPath, `${row.source} sampled archive manifest`),
    `${row.source} sampled archive manifest`,
  );
  if (canonicalJson(storedManifest) !== canonicalJson(diskManifest)) {
    throw new RealHistoryVerificationError(
      `${row.source} sampled archive manifest differs from the stored manifest`,
    );
  }

  for (const entry of diskManifest.files) {
    const bytes = await readBytes(
      archiveFilePath(manifestPath, entry.archive_path),
      `${row.source} sampled archive file`,
    );
    const actualSha256 = createHash('sha256').update(bytes).digest('hex');
    if (actualSha256 !== entry.sha256.toLowerCase()) {
      throw new RealHistoryVerificationError(
        `${row.source} sampled archive SHA-256 mismatch`,
      );
    }
    if (bytes.byteLength !== entry.size) {
      throw new RealHistoryVerificationError(`${row.source} sampled archive size mismatch`);
    }
  }
  return diskManifest.files.length;
}

function selectSamples(
  rows: readonly ValidatedHistoryRow[],
  source: TranscriptSource,
  sampleSize: number,
): ValidatedHistoryRow[] {
  const uniqueManifests = new Map<string, ValidatedHistoryRow>();
  for (const row of rows) {
    if (row.source !== source || uniqueManifests.has(row.manifest.manifest_path)) continue;
    uniqueManifests.set(row.manifest.manifest_path, row);
  }
  return [...uniqueManifests.values()]
    .sort((left, right) => sampleScore(left).localeCompare(sampleScore(right)))
    .slice(0, sampleSize);
}

export async function verifyRealHistory(
  input: RealHistoryVerificationOptions,
  dependencies: RealHistoryVerificationDependencies,
): Promise<RealHistoryVerificationReport> {
  const options = RealHistoryVerificationOptionsSchema.parse(input);
  const expected = dependencies.expectedInventory ?? EXPECTED_REAL_HISTORY_INVENTORY;
  const inventory = await verifyInventory(options.cursorFile, expected);
  const syncRuns = await verifySyncSummaries(
    options.syncSummaryFiles,
    options.cursorFile,
    expected,
  );
  const query = await dependencies.database.query<unknown>(
    `SELECT id::text, source, source_identifier, summary, raw_archive_manifest
       FROM content_items
      WHERE tenant_id = $1
        AND content_type = 'chat'
        AND source = ANY($2::text[])
      ORDER BY source, source_identifier, id`,
    [options.tenantId, TRANSCRIPT_SOURCES],
  );
  const rows = validateRows(query.rows);
  const historyRows = emptySourceCounts();
  const validatedManifests = emptySourceCounts();
  const sampledArchives = emptySourceCounts();
  const sampledFiles = emptySourceCounts();

  for (const row of rows) {
    historyRows[row.source] += 1;
    validatedManifests[row.source] += 1;
  }
  for (const source of TRANSCRIPT_SOURCES) {
    if (historyRows[source] === 0) {
      throw new RealHistoryVerificationError(`${source} has no stored history rows`);
    }
    const samples = selectSamples(rows, source, options.sampleSize);
    for (const sample of samples) {
      sampledFiles[source] += await verifySampledManifest(sample);
      sampledArchives[source] += 1;
    }
  }

  return {
    inventory,
    historyRows,
    validatedManifests,
    sampledArchives,
    sampledFiles,
    syncRuns,
  };
}

function parseCliOptions(argv: readonly string[]): RealHistoryVerificationOptions {
  const parsed = parseArgs({
    args: [...argv],
    allowPositionals: false,
    strict: true,
    options: {
      'cursor-file': { type: 'string', default: syncCursorFilePath() },
      'sample-size': { type: 'string', default: '3' },
      'sync-summary': { type: 'string', multiple: true },
      'tenant-id': {
        type: 'string',
        default: process.env.DEFAULT_TENANT_ID ?? '00000000-0000-0000-0000-000000000001',
      },
    },
  });
  return RealHistoryVerificationOptionsSchema.parse({
    tenantId: parsed.values['tenant-id'],
    cursorFile: parsed.values['cursor-file'],
    syncSummaryFiles: parsed.values['sync-summary'] ?? [],
    sampleSize: Number(parsed.values['sample-size']),
  });
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const pool = createDatabasePool();
  const database: RealHistoryDatabase = {
    async query<Row>(text: string, values: unknown[]): Promise<{ rows: Row[] }> {
      const result = await pool.query(text, values);
      return { rows: result.rows as unknown as Row[] };
    },
  };
  try {
    const report = await verifyRealHistory(options, { database });
    process.stdout.write(`${JSON.stringify({ success: true, data: report }, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof z.ZodError
      ? `invalid verifier input: ${formatZodIssues(error)}`
      : error instanceof Error ? error.message : String(error);
    process.stderr.write(`Real history verification failed: ${message}\n`);
    process.exitCode = 1;
  });
}
