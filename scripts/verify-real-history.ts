import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  RawArchiveManifestSchema,
  RawArchiveManifestV1Schema,
  RawArchiveManifestV2Schema,
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

const StoredRawArchiveManifestSchema = z.discriminatedUnion('version', [
  RawArchiveManifestV1Schema.extend({ manifest_path: NonEmptyStringSchema }),
  RawArchiveManifestV2Schema.extend({ manifest_path: NonEmptyStringSchema }),
]);

const RealHistoryRowSchema = z.object({
  id: NonEmptyStringSchema,
  source: TranscriptSourceSchema,
  source_identifier: NonEmptyStringSchema,
  summary: z.string().nullable(),
  raw_archive_manifest: z.unknown().nullable(),
}).strict();

const RealHistoryIndexRowSchema = z.object({
  id: NonEmptyStringSchema,
  source: TranscriptSourceSchema,
  source_identifier: NonEmptyStringSchema,
  summary: z.string().nullable(),
  manifest_path: z.string().nullable(),
  manifest_valid: z.boolean(),
}).strict();

export type RealHistoryRow = z.infer<typeof RealHistoryRowSchema>;

export interface RealHistoryDatabase {
  query<Row>(text: string, values: unknown[]): Promise<{ rows: Row[] }>;
}

export interface RealHistoryVerificationOptions {
  tenantId: string;
  cursorFile: string;
  syncSummaryFiles: string[];
  syncLogFile?: string;
  syncAfter?: string;
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
  syncCompletedAt: Record<TranscriptSource, string | null>;
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
  syncSummaryFiles: z.array(NonEmptyStringSchema),
  syncLogFile: NonEmptyStringSchema.optional(),
  syncAfter: z.string().datetime().optional(),
  sampleSize: z.number().int().positive().max(100),
}).strict().superRefine((value, context) => {
  const hasSummaries = value.syncSummaryFiles.length > 0;
  const hasLog = value.syncLogFile !== undefined;
  if (hasSummaries === hasLog) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'provide either sync summary files or one sync log file',
      path: ['syncSummaryFiles'],
    });
  }
  if (value.syncAfter && !hasLog) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'syncAfter requires syncLogFile',
      path: ['syncAfter'],
    });
  }
});

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
): Promise<Record<TranscriptSource, number>> {
  const inventory = parseDocument(
    CursorInventorySchema,
    await readJson(cursorFile, 'sync cursor inventory'),
    'sync cursor inventory',
  );
  const counts = emptySourceCounts();
  const skipped = emptySourceCounts();
  for (const [key, cursor] of Object.entries(inventory.files)) {
    const source = inventorySource(key);
    if (source) {
      counts[source] += 1;
      skipped[source] += cursor.skippedCount;
    }
  }
  for (const source of TRANSCRIPT_SOURCES) {
    if (skipped[source] > 0) {
      throw new RealHistoryVerificationError(
        `${source} cursor inventory reports ${skipped[source]} skipped item`
        + `${skipped[source] === 1 ? '' : 's'}`,
      );
    }
  }
  return counts;
}

async function verifySyncSummaries(
  summaries: readonly z.infer<typeof SyncRunSummarySchema>[],
  cursorFile: string,
  cursorInventory: Readonly<Record<TranscriptSource, number>>,
  expected: Readonly<Record<TranscriptSource, number>>,
): Promise<{
  inventory: Record<TranscriptSource, number>;
  runs: Record<TranscriptSource, number>;
}> {
  const inventory = emptySourceCounts();
  const runs = emptySourceCounts();
  for (const summary of summaries) {
    runs[summary.sourceId] += 1;
    inventory[summary.sourceId] = summary.filesScanned;
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
    if (summary.filesScanned < expected[summary.sourceId]) {
      throw new RealHistoryVerificationError(
        `${summary.sourceId} sync scan: expected at least ${expected[summary.sourceId]} files, `
        + `found ${summary.filesScanned}`,
      );
    }
    if (cursorInventory[summary.sourceId] < summary.filesScanned) {
      throw new RealHistoryVerificationError(
        `${summary.sourceId} cursor inventory: expected at least ${summary.filesScanned}, `
        + `found ${cursorInventory[summary.sourceId]}`,
      );
    }
  }
  for (const source of TRANSCRIPT_SOURCES) {
    if (runs[source] !== 1) {
      throw new RealHistoryVerificationError(
        `${source} requires exactly one successful sync summary; found ${runs[source]}`,
      );
    }
  }
  return { inventory, runs };
}

interface SyncEvidence {
  summaries: z.infer<typeof SyncRunSummarySchema>[];
  completedAt: Record<TranscriptSource, string | null>;
}

async function readSyncEvidence(
  options: z.infer<typeof RealHistoryVerificationOptionsSchema>,
): Promise<SyncEvidence> {
  const completedAt: Record<TranscriptSource, string | null> = {
    'claude-code': null,
    codex: null,
    cowork: null,
  };
  if (!options.syncLogFile) {
    const summaries = await Promise.all(options.syncSummaryFiles.map(async (file) => (
      parseDocument<z.infer<typeof SyncRunSummarySchema>>(
        SyncSummaryDocumentSchema,
        await readJson(file, 'sync summary'),
        'sync summary',
      )
    )));
    return { summaries, completedAt };
  }

  const log = (await readBytes(options.syncLogFile, 'sync service log')).toString('utf8');
  const latest = new Map<TranscriptSource, {
    timestamp: string;
    summary: z.infer<typeof SyncRunSummarySchema>;
  }>();
  const pattern = /^\[([^\]]+)\] source=(claude-code|codex|cowork) files=(\d+) found=(\d+) imported=(\d+) failed=(\d+) parseErrors=(\d+)$/gm;
  for (const match of log.matchAll(pattern)) {
    const timestamp = z.string().datetime().parse(match[1]);
    if (options.syncAfter && timestamp < options.syncAfter) continue;
    const sourceId = TranscriptSourceSchema.parse(match[2]);
    const summary = SyncRunSummarySchema.parse({
      sourceId,
      cursorFile: options.cursorFile,
      filesScanned: Number(match[3]),
      turnsFound: Number(match[4]),
      turnsImported: Number(match[5]),
      failedItems: Number(match[6]),
      parseErrors: Number(match[7]),
    });
    latest.set(sourceId, { timestamp, summary });
  }
  const summaries: z.infer<typeof SyncRunSummarySchema>[] = [];
  for (const source of TRANSCRIPT_SOURCES) {
    const evidence = latest.get(source);
    if (!evidence) {
      throw new RealHistoryVerificationError(
        `${source} has no sync service run${options.syncAfter ? ` after ${options.syncAfter}` : ''}`,
      );
    }
    summaries.push(evidence.summary);
    completedAt[source] = evidence.timestamp;
  }
  return { summaries, completedAt };
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

type RealHistoryIndexRow = z.infer<typeof RealHistoryIndexRowSchema>;

function validateIndexRows(rows: unknown[]): Array<RealHistoryIndexRow & { manifest_path: string }> {
  const parsedRows = rows.map((row) => parseDocument(
    RealHistoryIndexRowSchema,
    row,
    'database history index row',
  ));
  const missingSummaries = parsedRows.filter((row) => !row.summary?.trim());
  if (missingSummaries.length > 0) {
    throw new RealHistoryVerificationError(
      `${missingSummaries.length} history rows are missing summaries`,
    );
  }
  const missingManifests = parsedRows.filter((row) => (
    !row.manifest_valid || !row.manifest_path?.trim()
  ));
  if (missingManifests.length > 0) {
    throw new RealHistoryVerificationError(
      `${missingManifests.length} history rows are missing raw archive manifests`,
    );
  }
  return parsedRows as Array<RealHistoryIndexRow & { manifest_path: string }>;
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
    if (diskManifest.version === 1) {
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
      continue;
    }

    const archiveRoot = dirname(dirname(manifestPath));
    const digest = createHash('sha256');
    let totalBytes = 0;
    for (const chunk of entry.chunks) {
      const chunkPath = archiveFilePath(join(archiveRoot, 'manifest.json'), chunk.archive_path);
      const bytes = await readBytes(chunkPath, `${row.source} sampled archive chunk`);
      if (bytes.byteLength !== chunk.size
        || createHash('sha256').update(bytes).digest('hex') !== chunk.sha256.toLowerCase()) {
        throw new RealHistoryVerificationError(`${row.source} sampled archive chunk integrity mismatch`);
      }
      digest.update(bytes);
      totalBytes += bytes.byteLength;
    }
    if (totalBytes !== entry.size || digest.digest('hex') !== entry.sha256.toLowerCase()) {
      throw new RealHistoryVerificationError(`${row.source} sampled archive integrity mismatch`);
    }
  }
  return diskManifest.files.length;
}

function selectSamples(
  rows: readonly Array<RealHistoryIndexRow & { manifest_path: string }>,
  source: TranscriptSource,
  sampleSize: number,
): Array<RealHistoryIndexRow & { manifest_path: string }> {
  const uniqueManifests = new Map<string, RealHistoryIndexRow & { manifest_path: string }>();
  for (const row of rows) {
    if (row.source !== source || uniqueManifests.has(row.manifest_path)) continue;
    uniqueManifests.set(row.manifest_path, row);
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
  const cursorInventory = await verifyInventory(options.cursorFile);
  const syncEvidenceInput = await readSyncEvidence(options);
  const syncEvidence = await verifySyncSummaries(
    syncEvidenceInput.summaries,
    options.cursorFile,
    cursorInventory,
    expected,
  );
  const query = await dependencies.database.query<unknown>(
    `SELECT id::text, source, source_identifier, summary,
            raw_archive_manifest->>'manifest_path' AS manifest_path,
            CASE
              WHEN jsonb_typeof(raw_archive_manifest) = 'object'
               AND jsonb_typeof(raw_archive_manifest->'files') = 'array'
              THEN jsonb_array_length(raw_archive_manifest->'files') > 0
              ELSE false
            END AS manifest_valid
       FROM content_items
      WHERE tenant_id = $1
        AND content_type = 'chat'
        AND source = ANY($2::text[])
      ORDER BY source, source_identifier, id`,
    [options.tenantId, TRANSCRIPT_SOURCES],
  );
  const rows = validateIndexRows(query.rows);
  const historyRows = emptySourceCounts();
  const validatedManifests = emptySourceCounts();
  const sampledArchives = emptySourceCounts();
  const sampledFiles = emptySourceCounts();
  const sampleCandidates: Array<RealHistoryIndexRow & { manifest_path: string }> = [];

  for (const row of rows) {
    historyRows[row.source] += 1;
    validatedManifests[row.source] += 1;
  }
  for (const source of TRANSCRIPT_SOURCES) {
    if (historyRows[source] === 0) {
      throw new RealHistoryVerificationError(`${source} has no stored history rows`);
    }
    const samples = selectSamples(rows, source, options.sampleSize);
    if (samples.length !== options.sampleSize) {
      throw new RealHistoryVerificationError(
        `${source} archive sample: expected ${options.sampleSize}, found ${samples.length}`,
      );
    }
    sampleCandidates.push(...samples);
  }

  const sampleQuery = await dependencies.database.query<unknown>(
    `SELECT id::text, source, source_identifier, summary, raw_archive_manifest
       FROM content_items
      WHERE tenant_id = $1
        AND id = ANY($2::uuid[])
      ORDER BY source, source_identifier, id`,
    [options.tenantId, sampleCandidates.map((sample) => sample.id)],
  );
  const samples = validateRows(sampleQuery.rows);
  if (samples.length !== sampleCandidates.length) {
    throw new RealHistoryVerificationError(
      `archive sample query: expected ${sampleCandidates.length}, found ${samples.length}`,
    );
  }
  for (const sample of samples) {
    sampledFiles[sample.source] += await verifySampledManifest(sample);
    sampledArchives[sample.source] += 1;
  }

  return {
    inventory: syncEvidence.inventory,
    historyRows,
    validatedManifests,
    sampledArchives,
    sampledFiles,
    syncRuns: syncEvidence.runs,
    syncCompletedAt: syncEvidenceInput.completedAt,
  };
}

type ProcessRunner = (
  command: string,
  args: readonly string[],
  input: string,
) => Promise<{ status: number; stdout: string; stderr: string }>;

const runProcess: ProcessRunner = (command, args, input) => new Promise((resolvePromise, reject) => {
  const child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', (status) => resolvePromise({ status: status ?? 1, stdout, stderr }));
  child.stdin.end(input);
});

export class InstallerComposeDatabase implements RealHistoryDatabase {
  constructor(
    private readonly home: string,
    private readonly runner: ProcessRunner = runProcess,
    private readonly configuredProjectName?: string,
  ) {}

  private async projectName(): Promise<string> {
    if (this.configuredProjectName) return this.configuredProjectName;
    const environment = (await readBytes(
      join(this.home, '.env.compose'),
      'installer Compose environment',
    )).toString('utf8');
    const projectName = environment.match(/^COMPOSE_PROJECT_NAME=([a-zA-Z0-9_-]+)$/m)?.[1];
    if (!projectName) {
      throw new RealHistoryVerificationError(
        'installer Compose environment is missing a safe COMPOSE_PROJECT_NAME',
      );
    }
    return projectName;
  }

  async query<Row>(text: string, values: unknown[]): Promise<{ rows: Row[] }> {
    const tenantId = z.string().uuid().parse(values[0]);
    const parameters: Array<[string, string]> = [['tenant_id', tenantId]];
    let parameterized = text.replace('$1', ":'tenant_id'::uuid");
    if (parameterized.includes('$2::text[]')) {
      const sources = z.array(TranscriptSourceSchema)
        .length(TRANSCRIPT_SOURCES.length)
        .parse(values[1]);
      parameterized = parameterized.replace(
        '$2::text[]',
        "string_to_array(:'sources', ',')::text[]",
      );
      parameters.push(['sources', sources.join(',')]);
    } else if (parameterized.includes('$2::uuid[]')) {
      const ids = z.array(z.string().uuid()).min(1).max(100).parse(values[1]);
      parameterized = parameterized.replace(
        '$2::uuid[]',
        "string_to_array(:'ids', ',')::uuid[]",
      );
      parameters.push(['ids', ids.join(',')]);
    }
    if (/\$\d+/.test(parameterized)) {
      throw new RealHistoryVerificationError('installer database query has unsupported parameters');
    }
    const sql = `SELECT row_to_json(history)::text FROM (${parameterized}) history;\n`;
    const projectName = await this.projectName();
    const result = await this.runner('docker', [
      'compose',
      '--project-name', projectName,
      '--project-directory', this.home,
      '--env-file', join(this.home, '.env.compose'),
      '-f', join(this.home, 'docker-compose.yml'),
      'exec', '-T', 'postgres',
      'psql', '-U', 'postgres', '-d', 'answerengine',
      '-v', 'ON_ERROR_STOP=1',
      ...parameters.flatMap(([name, value]) => ['-v', `${name}=${value}`]),
      '-Atq', '-f', '-',
    ], sql);
    if (result.status !== 0) {
      throw new RealHistoryVerificationError(
        `installer database query failed: ${result.stderr.trim() || `exit ${result.status}`}`,
      );
    }
    const parsed = result.stdout.split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as unknown);
    return { rows: parsed as Row[] };
  }
}

function parseCliOptions(argv: readonly string[]): {
  installerHome?: string;
  verification: RealHistoryVerificationOptions;
} {
  const parsed = parseArgs({
    args: [...argv],
    allowPositionals: false,
    strict: true,
    options: {
      'cursor-file': { type: 'string', default: syncCursorFilePath() },
      'installer-home': { type: 'string' },
      'sample-size': { type: 'string', default: '3' },
      'sync-after': { type: 'string' },
      'sync-log': { type: 'string' },
      'sync-summary': { type: 'string', multiple: true },
      'tenant-id': {
        type: 'string',
        default: process.env.DEFAULT_TENANT_ID ?? '00000000-0000-0000-0000-000000000001',
      },
    },
  });
  const verification = RealHistoryVerificationOptionsSchema.parse({
    tenantId: parsed.values['tenant-id'],
    cursorFile: parsed.values['cursor-file'],
    syncSummaryFiles: parsed.values['sync-summary'] ?? [],
    syncLogFile: parsed.values['sync-log'],
    syncAfter: parsed.values['sync-after'],
    sampleSize: Number(parsed.values['sample-size']),
  });
  return {
    verification,
    ...(parsed.values['installer-home']
      ? { installerHome: resolve(parsed.values['installer-home']) }
      : {}),
  };
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const pool = options.installerHome ? undefined : createDatabasePool();
  const database: RealHistoryDatabase = options.installerHome
    ? new InstallerComposeDatabase(options.installerHome)
    : {
      async query<Row>(text: string, values: unknown[]): Promise<{ rows: Row[] }> {
        const result = await pool?.query(text, values);
        return { rows: (result?.rows ?? []) as unknown as Row[] };
      },
    };
  try {
    const report = await verifyRealHistory(options.verification, { database });
    process.stdout.write(`${JSON.stringify({ success: true, data: report }, null, 2)}\n`);
  } finally {
    await pool?.end();
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
