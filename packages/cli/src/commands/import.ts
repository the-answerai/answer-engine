/**
 * Import Commands
 * ae import csv, ae import json
 */

import { readFileSync, statSync } from 'node:fs';
import { parse as parseCsvSync } from 'csv-parse/sync';
import { Command } from 'commander';
import { createClient, handleApiError } from '../client.js';
import type {
  ImportItem,
  ImportParseError,
  ImportPreviewResult,
  ImportRequest,
  ImportSubmitResult,
} from '../api-client.js';
import {
  isInteractiveOutput,
  printError,
  printHeader,
  printJson,
  printWarning,
} from '../output.js';

const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
const DEFAULT_BATCH_SIZE = 50;

const ALLOWED_CONTENT_TYPES = [
  'call',
  'document',
  'ticket',
  'chat',
  'page',
] as const;

type AllowedContentType = (typeof ALLOWED_CONTENT_TYPES)[number];
type ImportFormat = 'csv' | 'json';
type SourceRecord = Record<string, unknown>;

interface ImportCommandOptions {
  type?: string;
  batchSize: string;
  dryRun?: boolean;
  mapTitle?: string;
  mapContent?: string;
}

interface LoadedRecords {
  records: SourceRecord[];
  headers: string[];
}

interface DetectedMappings {
  title?: string;
  content?: string;
  url?: string;
  contentType?: string;
  sourceIdentifier?: string;
}

interface LocalImportError {
  rowIndex: number;
  col?: string;
  error: string;
}

interface NormalizedImport {
  payload: ImportRequest;
  mappings: DetectedMappings;
  inferredContentType: AllowedContentType;
  localErrors: LocalImportError[];
}

class UserInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserInputError';
  }
}

const TITLE_CANDIDATES = ['title', 'page_title', 'name', 'headline', 'subject', 'label'];
const CONTENT_CANDIDATES = [
  'content',
  'description',
  'body',
  'text',
  'summary',
  'notes',
  'transcript',
];
const URL_CANDIDATES = [
  'external_url',
  'source_url',
  'page_url',
  'url',
  'website',
  'link',
  'href',
];
const SOURCE_ID_CANDIDATES = [
  'source_identifier',
  'source_id',
  'external_id',
  'id',
  'identifier',
];
const CONTENT_TYPE_CANDIDATES = ['content_type', 'contentType', 'type'];
const PRESERVED_IMPORT_FIELDS = new Set([
  'title',
  'content',
  'content_type',
  'contentType',
  'source_identifier',
  'sourceIdentifier',
  'external_url',
  'externalUrl',
  'source',
  'source_agent_id',
  'sourceAgentId',
  'conversation_id',
  'conversationId',
  'turn_index',
  'turnIndex',
  'turn_role',
  'turnRole',
  'turn_timestamp',
  'turnTimestamp',
  'turn_metadata',
  'turnMetadata',
  'analysis_data',
  'analysisData',
]);

const STRUCTURED_IMPORT_PREFIXES = [
  'metadata.',
  'analysis_data.',
  'source_data.',
];

function parseBatchSize(raw: string): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new UserInputError('--batch-size must be a positive integer');
  }
  return value;
}

function parseContentType(raw: string | undefined): AllowedContentType | undefined {
  if (!raw) return undefined;
  if (!(ALLOWED_CONTENT_TYPES as readonly string[]).includes(raw)) {
    throw new UserInputError(
      `--type must be one of: ${ALLOWED_CONTENT_TYPES.join(', ')}`
    );
  }
  return raw as AllowedContentType;
}

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeHeaderToken(value: string): string {
  return value.toLowerCase().replace(/[_\s-]+/g, ' ').trim();
}

function isGenericPartialCandidate(candidate: string): boolean {
  return ['id', 'name', 'url', 'site', 'text'].includes(candidate);
}

function detectByName(headers: string[], candidates: string[]): string | undefined {
  const headerInfo = headers
    .filter((header) => header.trim())
    .map((header) => ({
      raw: header,
      normalized: normalizeHeader(header),
      tokenized: normalizeHeaderToken(header),
    }));

  for (const candidate of candidates) {
    const normalizedCandidate = normalizeHeader(candidate);
    const exact = headerInfo.find((header) => header.normalized === normalizedCandidate);
    if (exact) return exact.raw;
  }

  for (const candidate of candidates) {
    if (isGenericPartialCandidate(candidate)) continue;
    const normalizedCandidate = normalizeHeader(candidate);
    const tokenCandidate = normalizeHeaderToken(candidate);
    const partial = headerInfo.find((header) =>
      header.normalized.includes(normalizedCandidate) ||
      header.tokenized.includes(tokenCandidate)
    );
    if (partial) return partial.raw;
  }

  return undefined;
}

function stringifyValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function firstRecordValue(record: SourceRecord, field: string | undefined): string | undefined {
  if (!field) return undefined;
  return stringifyValue(record[field]);
}

function extractHostname(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('@')) return undefined;

  try {
    const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    const parsed = new URL(withProtocol);
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
    return hostname || undefined;
  } catch {
    const withoutProtocol = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    const host = withoutProtocol.split(/[/?#]/)[0]?.split(':')[0]?.toLowerCase();
    return host?.replace(/^www\./, '') || undefined;
  }
}

function isHostnameLike(value: unknown): boolean {
  const hostname = extractHostname(stringifyValue(value));
  if (!hostname) return false;
  return /^(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,}$/i.test(hostname);
}

function isUrlLike(value: unknown): boolean {
  const text = stringifyValue(value);
  if (!text) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return isHostnameLike(text);
  return isHostnameLike(text);
}

function detectBySample(
  records: SourceRecord[],
  headers: string[],
  predicate: (value: unknown) => boolean
): string | undefined {
  let bestField: string | undefined;
  let bestScore = 0;
  let bestMatches = 0;

  for (const header of headers) {
    const values = records
      .slice(0, 50)
      .map((record) => record[header])
      .filter((value) => stringifyValue(value) !== undefined);
    if (values.length === 0) continue;

    const matches = values.filter(predicate).length;
    const score = matches / values.length;
    if (score > bestScore || (score === bestScore && matches > bestMatches)) {
      bestField = header;
      bestScore = score;
      bestMatches = matches;
    }
  }

  if (!bestField) return undefined;
  if (bestMatches >= 2 && bestScore >= 0.4) return bestField;
  if (bestMatches === 1 && bestScore >= 0.75) return bestField;
  return undefined;
}

function detectUrlField(records: SourceRecord[], headers: string[]): string | undefined {
  return (
    detectByName(headers, URL_CANDIDATES) ??
    detectBySample(records, headers, isUrlLike)
  );
}

function resolveExplicitHeader(headers: string[], value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = normalizeHeader(value);
  return headers.find((header) =>
    header === value || normalizeHeader(header) === normalized
  );
}

function detectMappings(
  records: SourceRecord[],
  headers: string[],
  opts: ImportCommandOptions
): { mappings: DetectedMappings; localErrors: LocalImportError[] } {
  const localErrors: LocalImportError[] = [];
  const explicitTitle = resolveExplicitHeader(headers, opts.mapTitle);
  const explicitContent = resolveExplicitHeader(headers, opts.mapContent);

  if (opts.mapTitle && !explicitTitle) {
    localErrors.push({
      rowIndex: 0,
      col: opts.mapTitle,
      error: `--map-title column "${opts.mapTitle}" was not found`,
    });
  }
  if (opts.mapContent && !explicitContent) {
    localErrors.push({
      rowIndex: 0,
      col: opts.mapContent,
      error: `--map-content column "${opts.mapContent}" was not found`,
    });
  }

  return {
    mappings: {
      title: explicitTitle ?? detectByName(headers, TITLE_CANDIDATES),
      content: explicitContent ?? detectByName(headers, CONTENT_CANDIDATES),
      url: detectUrlField(records, headers),
      contentType: detectByName(headers, CONTENT_TYPE_CANDIDATES),
      sourceIdentifier: detectByName(headers, SOURCE_ID_CANDIDATES),
    },
    localErrors,
  };
}

function inferContentType(
  explicitType: AllowedContentType | undefined,
  records: SourceRecord[],
  mappings: DetectedMappings
): AllowedContentType {
  if (explicitType) return explicitType;
  return 'document';
}

function normalizeExternalUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  if (isHostnameLike(trimmed)) return `https://${extractHostname(trimmed)}`;
  return trimmed;
}

function metadataKey(header: string): string {
  const key = header
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return key || 'column';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function flattenObject(
  target: ImportItem,
  prefix: string,
  value: Record<string, unknown>
): void {
  for (const [key, nestedValue] of Object.entries(value)) {
    if (nestedValue === undefined || nestedValue === null || nestedValue === '') continue;
    const nextPrefix = `${prefix}.${key}`;
    if (isPlainObject(nestedValue)) {
      flattenObject(target, nextPrefix, nestedValue);
    } else {
      target[nextPrefix] = nestedValue;
    }
  }
}

function addPreservedColumn(
  row: ImportItem,
  key: string,
  value: unknown,
  mappedColumns: Set<string>
): void {
  if (value === undefined || value === null || value === '') return;
  if (mappedColumns.has(key)) return;

  if (STRUCTURED_IMPORT_PREFIXES.some((prefix) => key.startsWith(prefix))) {
    row[key] = value;
    return;
  }

  if (PRESERVED_IMPORT_FIELDS.has(key)) {
    row[key] = value;
    return;
  }

  if (key === 'metadata' && isPlainObject(value)) {
    flattenObject(row, 'metadata', value);
    return;
  }

  if ((key === 'source_data' || key === 'sourceData') && isPlainObject(value)) {
    flattenObject(row, 'source_data', value);
    return;
  }

  row[`metadata.import.${metadataKey(key)}`] = value;
}

function progressEnabled(total: number, batchSize: number): boolean {
  return isInteractiveOutput() && total >= Math.max(batchSize * 2, 100);
}

function renderProgress(label: string, current: number, total: number, enabled: boolean): void {
  if (!enabled) return;
  const width = 24;
  const ratio = total === 0 ? 1 : Math.min(current / total, 1);
  const filled = Math.round(ratio * width);
  const bar = `${'#'.repeat(filled)}${'-'.repeat(width - filled)}`;
  process.stderr.write(`\r${label} [${bar}] ${current}/${total}`);
  if (current >= total) process.stderr.write('\n');
}

function normalizeRecords(
  records: SourceRecord[],
  headers: string[],
  opts: ImportCommandOptions,
  batchSize: number
): NormalizedImport {
  const explicitType = parseContentType(opts.type);
  const { mappings, localErrors } = detectMappings(records, headers, opts);
  const inferredContentType = inferContentType(explicitType, records, mappings);
  const items: ImportItem[] = [];
  const showProgress = progressEnabled(records.length, batchSize);
  const mappedColumns = new Set(
    Object.values(mappings).filter((value): value is string => Boolean(value))
  );

  for (let start = 0; start < records.length; start += batchSize) {
    const chunk = records.slice(start, start + batchSize);
    for (const [offset, record] of chunk.entries()) {
      const rowIndex = start + offset + 1;
      const row: ImportItem = {};
      const rawType = firstRecordValue(record, mappings.contentType);
      const rowType = explicitType ??
        (rawType && (ALLOWED_CONTENT_TYPES as readonly string[]).includes(rawType)
          ? rawType as AllowedContentType
          : inferredContentType);
      const rawUrl = firstRecordValue(record, mappings.url);
      const externalUrl = normalizeExternalUrl(rawUrl);
      const title = firstRecordValue(record, mappings.title) ??
        (externalUrl ? extractHostname(externalUrl) : undefined);
      const content = firstRecordValue(record, mappings.content);
      const sourceIdentifier = firstRecordValue(record, mappings.sourceIdentifier) ??
        externalUrl;

      if (!title) {
        localErrors.push({
          rowIndex,
          col: mappings.title ?? 'title',
          error: 'title could not be inferred; use --map-title or add a title/name column',
        });
        continue;
      }

      row.title = title;
      row.content_type = rowType;
      if (content) row.content = content;
      if (sourceIdentifier) row.source_identifier = sourceIdentifier;
      if (externalUrl) row.external_url = externalUrl;

      for (const [key, value] of Object.entries(record)) {
        addPreservedColumn(row, key, value, mappedColumns);
      }

      items.push(row);
    }
    renderProgress('Parsing', Math.min(start + chunk.length, records.length), records.length, showProgress);
  }

  return {
    payload: { items },
    mappings,
    inferredContentType,
    localErrors,
  };
}

function checkFile(path: string): void {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    throw new UserInputError(`File not found: ${path}`);
  }
  if (!stats.isFile()) {
    throw new UserInputError(`Path is not a file: ${path}`);
  }
  if (stats.size > MAX_IMPORT_BYTES) {
    throw new UserInputError('Import files are limited to 50 MB');
  }
}

function loadCsv(path: string): LoadedRecords {
  checkFile(path);
  const buffer = readFileSync(path);
  let headers: string[] = [];
  try {
    const records = parseCsvSync(buffer, {
      columns: (rawHeaders: string[]) => {
        headers = rawHeaders.map((header) => header.trim());
        return headers;
      },
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      bom: true,
    }) as SourceRecord[];
    return { records, headers };
  } catch (error) {
    throw new UserInputError(
      `CSV parse failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function collectHeaders(records: SourceRecord[]): string[] {
  const headers = new Set<string>();
  for (const record of records.slice(0, 50)) {
    Object.keys(record).forEach((key) => headers.add(key));
  }
  return [...headers];
}

function loadJson(path: string): LoadedRecords {
  checkFile(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new UserInputError(
      `JSON parse failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const rawRows = Array.isArray(parsed)
    ? parsed
    : isPlainObject(parsed) && Array.isArray(parsed.items)
      ? parsed.items
      : undefined;

  if (!rawRows) {
    throw new UserInputError('JSON import file must contain an array or an object with an items array');
  }

  const records = rawRows.map((row, index) => {
    if (!isPlainObject(row)) {
      throw new UserInputError(`JSON row ${index + 1} must be an object`);
    }
    return row;
  });

  return { records, headers: collectHeaders(records) };
}

function printMappings(
  mappings: DetectedMappings,
  inferredContentType: AllowedContentType
): void {
  if (!isInteractiveOutput()) return;
  printHeader('Detected Import Mapping');
  console.log(`  content_type: ${inferredContentType}`);
  console.log(`  title: ${mappings.title ?? '(derived)'}`);
  console.log(`  content: ${mappings.content ?? '(none)'}`);
  console.log(`  external_url: ${mappings.url ?? '(none)'}`);
}

function printLocalErrors(errors: LocalImportError[]): void {
  if (errors.length === 0 || !isInteractiveOutput()) return;
  printHeader(`Local Validation Errors (${errors.length})`);
  for (const error of errors.slice(0, 20)) {
    const column = error.col ? ` column ${error.col}` : '';
    console.log(`  Row ${error.rowIndex}${column}: ${error.error}`);
  }
  if (errors.length > 20) {
    console.log(`  ... ${errors.length - 20} more`);
  }
}

function printParseErrors(errors: ImportParseError[] | undefined): void {
  if (!errors?.length || !isInteractiveOutput()) return;
  printHeader(`API Parse Errors (${errors.length})`);
  for (const error of errors.slice(0, 20)) {
    const column = error.col ? ` column ${error.col}` : '';
    console.log(`  Row ${error.rowIndex}${column}: ${error.error}`);
  }
  if (errors.length > 20) {
    console.log(`  ... ${errors.length - 20} more`);
  }
}

function printPreview(
  preview: ImportPreviewResult,
  mappings: DetectedMappings,
  inferredContentType: AllowedContentType,
  localErrors: LocalImportError[]
): void {
  if (!isInteractiveOutput()) {
    printJson({ data: preview, mappings, inferredContentType, localErrors });
    return;
  }

  printHeader('Import Preview');
  console.log(`  Rows: ${preview.rowCount}`);
  console.log(`  Requires Stable IDs: ${preview.requiresIdForIdempotency ? 'yes' : 'no'}`);

  if (preview.sample.length > 0) {
    console.log('\n  Sample:');
    for (const item of preview.sample.slice(0, 5)) {
      console.log(`    - ${String(item.title ?? '(untitled)')} [${String(item.content_type ?? 'unknown')}]`);
    }
  }

  printLocalErrors(localErrors);
  printParseErrors(preview.parseErrors);
}

function printSubmitResult(result: ImportSubmitResult): void {
  if (!isInteractiveOutput()) {
    printJson({ data: result });
    return;
  }

  printHeader('Import Submitted');
  if (result.status) console.log(`  Status: ${result.status}`);
  console.log(`  Items: ${result.totalItems}`);
  if (result.requiresIdForIdempotency) {
    printWarning('Some rows are missing source_identifier; re-importing can create duplicates.');
  }
  printParseErrors(result.parseErrors);
  if (result.failures?.length) {
    printHeader(`Import Failures (${result.failures.length})`);
    for (const failure of result.failures.slice(0, 20)) {
      const row = failure.rowIndex ? `Row ${failure.rowIndex}: ` : '';
      console.log(`  ${row}${failure.error ?? failure.reason ?? 'unknown failure'}`);
    }
  }
}

async function runImport(
  format: ImportFormat,
  filePath: string,
  opts: ImportCommandOptions
): Promise<void> {
  try {
    const batchSize = parseBatchSize(opts.batchSize);
    parseContentType(opts.type);
    const loaded = format === 'csv' ? loadCsv(filePath) : loadJson(filePath);
    const normalized = normalizeRecords(loaded.records, loaded.headers, opts, batchSize);

    printMappings(normalized.mappings, normalized.inferredContentType);

    if (normalized.payload.items.length === 0) {
      printLocalErrors(normalized.localErrors);
      throw new UserInputError('No valid rows to import');
    }

    const client = createClient();
    const showSubmitProgress = progressEnabled(normalized.payload.items.length, batchSize);
    const preview = await client.importPreview(normalized.payload);

    if (opts.dryRun) {
      printPreview(
        preview.data,
        normalized.mappings,
        normalized.inferredContentType,
        normalized.localErrors
      );
      if (isInteractiveOutput()) {
        printHeader('Dry Run Complete');
        console.log('  No import job was created.');
      }
      return;
    }

    if (isInteractiveOutput()) {
      printPreview(
        preview.data,
        normalized.mappings,
        normalized.inferredContentType,
        normalized.localErrors
      );
    }

    renderProgress('Submitting', 0, normalized.payload.items.length, showSubmitProgress);
    const submitted = await client.submitImport(normalized.payload);
    renderProgress(
      'Submitting',
      normalized.payload.items.length,
      normalized.payload.items.length,
      showSubmitProgress
    );
    if (!isInteractiveOutput()) {
      printJson({
        data: submitted.data,
        preview: preview.data,
        mappings: normalized.mappings,
        inferredContentType: normalized.inferredContentType,
        localErrors: normalized.localErrors,
      });
      return;
    }

    printSubmitResult(submitted.data);
  } catch (error) {
    if (error instanceof UserInputError) {
      printError(error.message);
      process.exit(1);
    }
    handleApiError(error);
  }
}

export function registerImportCommands(program: Command): void {
  const importCommand = program
    .command('import')
    .description('Import content from CSV or JSON files');

  importCommand
    .command('csv')
    .description('Import content rows from a CSV file')
    .argument('<file>', 'CSV file path')
    .option('--type <type>', `Content type override: ${ALLOWED_CONTENT_TYPES.join(', ')}`)
    .option('--batch-size <n>', 'Rows per local parsing/progress batch', String(DEFAULT_BATCH_SIZE))
    .option('--dry-run', 'Validate and preview without creating an import job')
    .option('--map-title <column>', 'Column to use as title')
    .option('--map-content <column>', 'Column to use as content')
    .action((file: string, opts: ImportCommandOptions) => runImport('csv', file, opts));

  importCommand
    .command('json')
    .description('Import content rows from a JSON array file')
    .argument('<file>', 'JSON file path')
    .option('--type <type>', `Content type override: ${ALLOWED_CONTENT_TYPES.join(', ')}`)
    .option('--batch-size <n>', 'Rows per local parsing/progress batch', String(DEFAULT_BATCH_SIZE))
    .option('--dry-run', 'Validate and preview without creating an import job')
    .option('--map-title <field>', 'Field to use as title')
    .option('--map-content <field>', 'Field to use as content')
    .action((file: string, opts: ImportCommandOptions) => runImport('json', file, opts));
}

export const importCommandInternals = {
  detectUrlField,
  normalizeRecords,
  loadCsv,
  loadJson,
};
