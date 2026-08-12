import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import type { AnswerEngineClient } from '../api-client.js';
import { CursorStore } from './cursor-store.js';
import { importConversations, importDocuments, importTurns } from './importer.js';
import { claudeCodeSource } from './sources/claude-code.js';
import { codexSource } from './sources/codex.js';
import { coworkSource } from './sources/cowork.js';
import { localDirSource, resolveLocalDirInput } from './sources/local-dir.js';
import { loadUserConfig, UserConfigError, type UserConfig } from '../user-config.js';
import {
  LOCAL_DIR_SOURCE_ID,
  type LocalDirSkip,
  type SourceType,
  type TranscriptSource,
  type TranscriptSourceId,
} from './types.js';

export const SYNC_IMPORT_MAX_BATCH_SIZE = 25;
export const DEFAULT_SYNC_CONCURRENCY = 2;
export const SYNC_IMPORT_MAX_CONCURRENCY = 8;

type SyncClient = Pick<AnswerEngineClient, 'submitSyncImport'>
  & Partial<Pick<AnswerEngineClient, 'deleteContent'>>;

export interface SyncRunOptions {
  sourceId: SourceType;
  paths?: string[];
  include?: string[];
  exclude?: string[];
  contentType?: 'document';
  onDelete?: 'leave' | 'forget';
  maxFileBytes?: number;
  cursorFile?: string;
  batchSize: number;
  concurrency?: number;
  libraryId?: string;
  librarySlug?: string;
  client: SyncClient;
  onWarning?: (message: string) => void;
}

export interface SyncRunSummary {
  sourceId: SourceType;
  cursorFile: string;
  filesScanned: number;
  turnsFound: number;
  turnsImported: number;
  failedItems: number;
  parseErrors: number;
}

export interface SyncLoopOptions extends SyncRunOptions {
  pollIntervalMs: number;
  onRun?: (summary: SyncRunSummary) => void;
}

export interface ConfiguredSyncSource {
  sourceId: SourceType;
  paths?: string[];
  librarySlug?: string;
  include?: string[];
  exclude?: string[];
  contentType?: 'document';
  onDelete?: 'leave' | 'forget';
  maxFileBytes?: number;
}

export interface SyncSourcesLoopOptions {
  sources: ConfiguredSyncSource[];
  cursorFile?: string;
  batchSize: number;
  concurrency?: number;
  client: SyncClient;
  pollIntervalMs: number;
  onRun?: (summary: SyncRunSummary) => void;
}

export function resolveSyncSourcesFromConfig(
  config: UserConfig = loadUserConfig(),
): ConfiguredSyncSource[] {
  if (config.sources.length === 0) {
    throw new UserConfigError(
      'No sync sources are configured in config.yaml. Add an entry under sources.',
    );
  }

  return config.sources.map((source) => ({
    sourceId: source.type,
    ...(source.path ? { paths: [source.path] } : {}),
    ...(source.library ? { librarySlug: source.library } : {}),
    ...(source.include ? { include: source.include } : {}),
    ...(source.exclude ? { exclude: source.exclude } : {}),
    ...(source.content_type ? { contentType: source.content_type } : {}),
    ...(source.on_delete ? { onDelete: source.on_delete } : {}),
    ...(source.max_file_bytes ? { maxFileBytes: source.max_file_bytes } : {}),
  }));
}

function getSource(sourceId: TranscriptSourceId): TranscriptSource {
  if (sourceId === 'claude-code') return claudeCodeSource;
  if (sourceId === 'codex') return codexSource;
  if (sourceId === 'cowork') return coworkSource;
  throw new Error('Unsupported sync source');
}

async function fingerprintFile(filePath: string): Promise<string> {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

function defaultWarning(message: string): void {
  process.stderr.write(`[ae sync] ${message}\n`);
}

function localDirSkipMessage(event: LocalDirSkip): string {
  if (event.reason === 'too_large') {
    return `skipped oversize file ${event.path} (${event.size} bytes; max ${event.maxFileBytes})`;
  }
  return `skipped binary file ${event.path}`;
}

function isWithinRoot(filePath: string, rootPath: string): boolean {
  const child = relative(rootPath, filePath);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

async function pathIsMissing(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

async function rootCanConfirmDeletion(rootPath: string, filePath: string): Promise<boolean> {
  if (rootPath === filePath) return true;
  try {
    return (await stat(rootPath)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function runLocalDirSyncOnce(
  options: SyncRunOptions,
  cursorStore: CursorStore,
): Promise<SyncRunSummary> {
  if (!options.paths?.length) {
    throw new UserConfigError('local_dir sync requires at least one path');
  }
  const warn = options.onWarning ?? defaultWarning;
  const files = await localDirSource.discover({
    paths: options.paths,
    include: options.include,
    exclude: options.exclude,
    maxFileBytes: options.maxFileBytes,
    onSkip: (event) => warn(localDirSkipMessage(event)),
  });
  const summary: SyncRunSummary = {
    sourceId: LOCAL_DIR_SOURCE_ID,
    cursorFile: cursorStore.path,
    filesScanned: files.length,
    turnsFound: 0,
    turnsImported: 0,
    failedItems: 0,
    parseErrors: 0,
  };

  const discoveredPaths = new Set(files.map((file) => file.path));
  for (const file of files) {
    const cursor = await cursorStore.get(LOCAL_DIR_SOURCE_ID, file.path);
    let readResult;
    try {
      readResult = await localDirSource.readDocuments(file, options.contentType ?? 'document');
    } catch (error) {
      summary.parseErrors += 1;
      warn(`skipped unreadable document ${file.path}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    const document = readResult.documents[0];
    const metadataUnchanged = (
      cursor.fileSize === file.size
      && cursor.lastMtimeMs === file.mtimeMs
      && cursor.fileIdentity === file.identity
    );
    if (cursor.sourceSha256 === readResult.sourceFingerprint) {
      if (!metadataUnchanged) {
        await cursorStore.set(LOCAL_DIR_SOURCE_ID, file.path, {
          ...cursor,
          fileSize: file.size,
          lastMtimeMs: file.mtimeMs,
          fileIdentity: file.identity,
        });
      }
      continue;
    }

    summary.turnsFound += readResult.documents.length;
    const imported = await importDocuments(readResult.documents, {
      client: options.client,
      batchSize: options.batchSize,
      libraryId: options.libraryId,
      librarySlug: options.librarySlug,
    });
    summary.turnsImported += imported.importedItems;
    summary.failedItems += imported.failedItems;

    if (imported.failedItems === 0) {
      await cursorStore.set(LOCAL_DIR_SOURCE_ID, file.path, {
        offset: file.size,
        line: 0,
        importedCount: cursor.importedCount + imported.importedItems,
        skippedCount: cursor.skippedCount,
        fileSize: file.size,
        lastMtimeMs: file.mtimeMs,
        fileIdentity: file.identity,
        sourceSha256: readResult.sourceFingerprint,
        lastImportedSourceIdentifier: document?.sourceIdentifier,
        contentId: imported.contentIds[0] ?? cursor.contentId,
      });
    }
  }

  const roots = options.paths.map(resolveLocalDirInput);
  const localPrefix = `${LOCAL_DIR_SOURCE_ID}:`;
  for (const { key, cursor } of await cursorStore.entries()) {
    if (!key.startsWith(localPrefix)) continue;
    const filePath = key.slice(localPrefix.length);
    const matchingRoots = roots.filter((root) => isWithinRoot(filePath, root));
    if (matchingRoots.length === 0) continue;
    if (discoveredPaths.has(filePath)) continue;
    try {
      const rootAvailability = await Promise.all(
        matchingRoots.map((root) => rootCanConfirmDeletion(root, filePath)),
      );
      if (!rootAvailability.some(Boolean)) {
        warn(`deferred delete check for ${filePath}: configured source root is unavailable`);
        continue;
      }
      if (!await pathIsMissing(filePath)) continue;
    } catch (error) {
      summary.parseErrors += 1;
      warn(`could not check local file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    if ((options.onDelete ?? 'leave') === 'forget') {
      if (!cursor.contentId || !options.client.deleteContent) {
        summary.failedItems += 1;
        warn(`could not forget missing local file ${filePath}: synced content ID is unavailable`);
        continue;
      }
      try {
        await options.client.deleteContent(cursor.contentId);
      } catch (error) {
        summary.failedItems += 1;
        warn(`could not forget missing local file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
    }
    await cursorStore.remove(LOCAL_DIR_SOURCE_ID, filePath);
  }

  await cursorStore.save();
  return summary;
}

async function processWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  handler: (value: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  let firstError: unknown;
  const worker = async (): Promise<void> => {
    while (firstError === undefined) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      try {
        await handler(values[index] as T);
      } catch (error) {
        firstError = error;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  );
  if (firstError !== undefined) throw firstError;
}

export async function runSyncOnce(options: SyncRunOptions): Promise<SyncRunSummary> {
  const cursorStore = new CursorStore(options.cursorFile);
  if (options.sourceId === LOCAL_DIR_SOURCE_ID) {
    return runLocalDirSyncOnce(options, cursorStore);
  }

  const source = getSource(options.sourceId);
  const warn = options.onWarning ?? defaultWarning;
  const files = await source.discover({ paths: options.paths });
  const summary: SyncRunSummary = {
    sourceId: source.id,
    cursorFile: cursorStore.path,
    filesScanned: files.length,
    turnsFound: 0,
    turnsImported: 0,
    failedItems: 0,
    parseErrors: 0,
  };

  await processWithConcurrency(
    files,
    options.concurrency ?? DEFAULT_SYNC_CONCURRENCY,
    async (file) => {
    const cursor = await cursorStore.get(source.id, file.path);
    if (source.readConversations) {
      const sourceSha256 = source.fingerprint
        ? await source.fingerprint(file)
        : await fingerprintFile(file.path);
      const metadataUnchanged = (
        cursor.fileSize === file.size &&
        cursor.lastMtimeMs === file.mtimeMs &&
        cursor.fileIdentity === file.identity
      );
      if (cursor.sourceSha256 === sourceSha256) {
        if (!metadataUnchanged) {
          await cursorStore.set(source.id, file.path, {
            ...cursor,
            fileSize: file.size,
            lastMtimeMs: file.mtimeMs,
            fileIdentity: file.identity,
          });
          await cursorStore.save();
        }
        return;
      }

      const readResult = await source.readConversations(file);
      summary.turnsFound += readResult.conversations.length;
      summary.parseErrors += readResult.errors.length;

      let importedCount = 0;
      let failedCount = 0;
      if (readResult.conversations.length > 0) {
        const imported = await importConversations(readResult.conversations, {
          client: options.client,
          batchSize: options.batchSize,
          libraryId: options.libraryId,
          librarySlug: options.librarySlug,
        });
        importedCount = imported.importedItems;
        failedCount = imported.failedItems;
        summary.turnsImported += imported.importedItems;
        summary.failedItems += imported.failedItems;
        for (const failure of imported.failures) {
          warn(
            `import failed for ${file.path}`
            + `${failure.rowIndex === undefined ? '' : ` row ${failure.rowIndex}`}: `
            + `${failure.error ?? failure.reason ?? 'unknown import error'}`,
          );
        }
      }

      if (failedCount === 0) {
        const lastConversation = readResult.conversations.at(-1);
        await cursorStore.set(source.id, file.path, {
          offset: file.size,
          line: readResult.processedLines,
          importedCount: cursor.importedCount + importedCount,
          skippedCount: cursor.skippedCount + readResult.errors.length,
          fileSize: file.size,
          lastMtimeMs: file.mtimeMs,
          fileIdentity: file.identity,
          sourceSha256: readResult.sourceFingerprint,
          lastImportedSourceIdentifier: lastConversation
            ? `${lastConversation.provider}:${lastConversation.surface}:${lastConversation.source_conversation_id}`
            : cursor.lastImportedSourceIdentifier,
        });
        await cursorStore.save();
      }
      return;
    }

    if (!source.readNewTurns) {
      throw new Error(`Sync source ${source.id} does not implement a transcript reader`);
    }
    const readResult = await source.readNewTurns(file, cursor);
    summary.turnsFound += readResult.turns.length;
    summary.parseErrors += readResult.errors.length;

    let importedCount = 0;
    let failedCount = 0;
    if (readResult.turns.length > 0) {
      const imported = await importTurns(readResult.turns, {
        client: options.client,
        batchSize: options.batchSize,
        libraryId: options.libraryId,
        librarySlug: options.librarySlug,
      });
      importedCount = imported.importedItems;
      failedCount = imported.failedItems;
      summary.turnsImported += imported.importedItems;
      summary.failedItems += imported.failedItems;
      for (const failure of imported.failures) {
        warn(
          `import failed for ${file.path}`
          + `${failure.rowIndex === undefined ? '' : ` row ${failure.rowIndex}`}: `
          + `${failure.error ?? failure.reason ?? 'unknown import error'}`,
        );
      }
    }

    if (failedCount === 0) {
      await cursorStore.set(source.id, file.path, {
        ...readResult.nextCursor,
        importedCount: cursor.importedCount + importedCount,
      });
      await cursorStore.save();
    }
    },
  );

  await cursorStore.save();
  return summary;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function runSyncLoop(options: SyncLoopOptions): Promise<void> {
  return runSyncSourcesLoop({
    sources: [{
      sourceId: options.sourceId,
      ...(options.paths ? { paths: options.paths } : {}),
      ...(options.librarySlug ? { librarySlug: options.librarySlug } : {}),
      ...(options.include ? { include: options.include } : {}),
      ...(options.exclude ? { exclude: options.exclude } : {}),
      ...(options.contentType ? { contentType: options.contentType } : {}),
      ...(options.onDelete ? { onDelete: options.onDelete } : {}),
      ...(options.maxFileBytes ? { maxFileBytes: options.maxFileBytes } : {}),
    }],
    cursorFile: options.cursorFile,
    batchSize: options.batchSize,
    concurrency: options.concurrency,
    client: options.client,
    pollIntervalMs: options.pollIntervalMs,
    onRun: options.onRun,
  });
}

export async function runSyncSourcesLoop(options: SyncSourcesLoopOptions): Promise<void> {
  let stopping = false;
  const stop = (): void => {
    stopping = true;
  };

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    while (!stopping) {
      for (const source of options.sources) {
        if (stopping) break;
        const summary = await runSyncOnce({
          ...source,
          cursorFile: options.cursorFile,
          batchSize: options.batchSize,
          concurrency: options.concurrency,
          client: options.client,
        });
        options.onRun?.(summary);
      }
      if (!stopping) await sleep(options.pollIntervalMs);
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
