/**
 * Sync Commands
 * ae sync once, ae sync run, ae sync install-service, ae sync uninstall-service, ae sync status
 */

import { Command } from 'commander';
import { createClient, handleApiError } from '../client.js';
import { printError, printHeader, printJson, printSuccess } from '../output.js';
import { CursorStore } from '../sync/cursor-store.js';
import {
  installService,
  queryServiceStatus,
  ServiceCommandError,
  ServicePlatformError,
  uninstallService,
} from '../sync/service.js';
import {
  runSyncLoop,
  runSyncOnce,
  runSyncSourcesLoop,
  resolveSyncSourcesFromConfig,
  DEFAULT_SYNC_CONCURRENCY,
  SYNC_IMPORT_MAX_BATCH_SIZE,
  SYNC_IMPORT_MAX_CONCURRENCY,
  type ConfiguredSyncSource,
  type SyncRunSummary,
} from '../sync/sync-daemon.js';
import {
  isSourceType,
  SUPPORTED_SYNC_SOURCES,
  type SourceType,
} from '../sync/types.js';
import { loadUserConfig, UserConfigError } from '../user-config.js';
import { assertHistorySyncAllowed, HistorySyncPolicyError } from '../sync/channel-policy.js';
import { resolveRuntimeChannel } from '../channel.js';

const DEFAULT_SYNC_BATCH_SIZE = 25;
const DEFAULT_POLL_INTERVAL_SECONDS = 15;

interface SyncCommandOptions {
  source?: string;
  path?: string[];
  library?: string;
  batchSize: string;
  concurrency: string;
  pollInterval: string;
  cursorFile?: string;
  confirmStagingHistorySync?: boolean;
}

class UserInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserInputError';
  }
}

function assertCommandHistorySync(confirmed: boolean): void {
  const policy = resolveRuntimeChannel() === 'staging' ? loadUserConfig().history_sync : undefined;
  assertHistorySyncAllowed(policy, confirmed);
}

function collectPath(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function parseSource(value: string): SourceType {
  if (isSourceType(value)) return value;
  throw new UserInputError(`--source must be one of: ${SUPPORTED_SYNC_SOURCES.join(', ')}`);
}

function parsePositiveInteger(raw: string, name: string): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new UserInputError(`${name} must be a positive integer`);
  }
  return value;
}

function parseBatchSize(raw: string): number {
  const batchSize = parsePositiveInteger(raw, '--batch-size');
  if (batchSize > SYNC_IMPORT_MAX_BATCH_SIZE) {
    throw new UserInputError(`--batch-size must be ${SYNC_IMPORT_MAX_BATCH_SIZE} or less`);
  }
  return batchSize;
}

function parseConcurrency(raw: string): number {
  const concurrency = parsePositiveInteger(raw, '--concurrency');
  if (concurrency > SYNC_IMPORT_MAX_CONCURRENCY) {
    throw new UserInputError(`--concurrency must be ${SYNC_IMPORT_MAX_CONCURRENCY} or less`);
  }
  return concurrency;
}

function printSummary(summary: SyncRunSummary): void {
  printJson({ data: summary });
}

function printLoopSummary(summary: SyncRunSummary): void {
  const timestamp = new Date().toISOString();
  console.log(
    `[${timestamp}] source=${summary.sourceId} files=${summary.filesScanned} ` +
    `found=${summary.turnsFound} imported=${summary.turnsImported} ` +
    `failed=${summary.failedItems} parseErrors=${summary.parseErrors}`
  );
}

function resolveCommandSources(opts: SyncCommandOptions): ConfiguredSyncSource[] {
  const hasExplicitPaths = opts.path !== undefined && opts.path.length > 0;
  if (opts.source !== undefined || hasExplicitPaths) {
    return [{
      sourceId: parseSource(opts.source ?? 'claude-code'),
      ...(hasExplicitPaths ? { paths: opts.path } : {}),
      ...(opts.library ? { librarySlug: opts.library } : {}),
    }];
  }

  return resolveSyncSourcesFromConfig().map((source) => ({
    ...source,
    ...(opts.library ? { librarySlug: opts.library } : {}),
  }));
}

async function runOnceCommand(opts: SyncCommandOptions): Promise<void> {
  try {
    assertCommandHistorySync(opts.confirmStagingHistorySync ?? false);
    const sources = resolveCommandSources(opts);
    const batchSize = parseBatchSize(opts.batchSize);
    const concurrency = parseConcurrency(opts.concurrency);
    const client = createClient();
    let failedItems = 0;
    for (const source of sources) {
      const summary = await runSyncOnce({
        ...source,
        cursorFile: opts.cursorFile,
        batchSize,
        concurrency,
        client,
      });
      printSummary(summary);
      failedItems += summary.failedItems;
    }
    if (failedItems > 0) process.exitCode = 1;
  } catch (error) {
    if (error instanceof UserInputError || error instanceof UserConfigError || error instanceof HistorySyncPolicyError) {
      printError(error.message);
      process.exit(1);
    }
    handleApiError(error);
  }
}

async function runDaemonCommand(opts: SyncCommandOptions): Promise<void> {
  try {
    assertCommandHistorySync(opts.confirmStagingHistorySync ?? false);
    const sources = resolveCommandSources(opts);
    const batchSize = parseBatchSize(opts.batchSize);
    const concurrency = parseConcurrency(opts.concurrency);
    const pollIntervalMs = parsePositiveInteger(opts.pollInterval, '--poll-interval') * 1000;
    const client = createClient();
    printHeader('Answer Engine Sync');
    if (sources.length === 1 && (opts.source !== undefined || (opts.path?.length ?? 0) > 0)) {
      const [source] = sources;
      await runSyncLoop({
        ...source,
        cursorFile: opts.cursorFile,
        batchSize,
        concurrency,
        pollIntervalMs,
        client,
        onRun: printLoopSummary,
      });
      return;
    }
    await runSyncSourcesLoop({
      sources,
      cursorFile: opts.cursorFile,
      batchSize,
      concurrency,
      pollIntervalMs,
      client,
      onRun: printLoopSummary,
    });
  } catch (error) {
    if (error instanceof UserInputError || error instanceof UserConfigError || error instanceof HistorySyncPolicyError) {
      printError(error.message);
      process.exit(1);
    }
    handleApiError(error);
  }
}

async function runStatusCommand(opts: Pick<SyncCommandOptions, 'cursorFile' | 'source'>): Promise<void> {
  try {
    const selectedSource = opts.source === undefined ? undefined : parseSource(opts.source);
    const store = new CursorStore(opts.cursorFile);
    const entries = await store.entries();
    let configuredSources: ConfiguredSyncSource[] = [];
    try {
      configuredSources = resolveSyncSourcesFromConfig();
    } catch (error) {
      if (!(error instanceof UserConfigError)) throw error;
    }

    const sourceIds = new Set<SourceType>();
    for (const source of configuredSources) sourceIds.add(source.sourceId);
    for (const { key } of entries) {
      const sourceId = SUPPORTED_SYNC_SOURCES.find((candidate) => key.startsWith(`${candidate}:`));
      if (sourceId !== undefined) sourceIds.add(sourceId);
    }
    const sources = [...sourceIds]
      .filter((sourceId) => selectedSource === undefined || sourceId === selectedSource)
      .map((sourceId) => {
        const sourceEntries = entries.filter(({ key }) => key.startsWith(`${sourceId}:`));
        const updatedAt = sourceEntries
          .map(({ cursor }) => cursor.updatedAt)
          .filter((value): value is string => value !== undefined)
          .sort()
          .at(-1);
        return {
          sourceId,
          configured: configuredSources.some((source) => source.sourceId === sourceId),
          files: sourceEntries.length,
          importedCount: sourceEntries.reduce((total, { cursor }) => total + cursor.importedCount, 0),
          skippedCount: sourceEntries.reduce((total, { cursor }) => total + cursor.skippedCount, 0),
          ...(updatedAt ? { lastUpdatedAt: updatedAt } : {}),
        };
      });
    const files = entries
      .filter(({ key }) => selectedSource === undefined || key.startsWith(`${selectedSource}:`))
      .map(({ key, cursor }) => ({
        key,
        offset: cursor.offset,
        line: cursor.line,
        importedCount: cursor.importedCount,
        skippedCount: cursor.skippedCount,
        fileSize: cursor.fileSize,
        lastMtimeMs: cursor.lastMtimeMs,
        sourceSha256: cursor.sourceSha256,
        contentId: cursor.contentId,
        updatedAt: cursor.updatedAt,
        lastImportedSourceIdentifier: cursor.lastImportedSourceIdentifier,
      }));
    printJson({
      data: {
        service: queryServiceStatus(),
        cursorFile: store.path,
        sources,
        files,
      },
    });
  } catch (error) {
    if (error instanceof UserInputError || error instanceof ServicePlatformError) {
      printError(error.message);
      process.exit(1);
    }
    throw error;
  }
}

function runInstallServiceCommand(opts: Pick<SyncCommandOptions, 'confirmStagingHistorySync'>): void {
  try {
    assertCommandHistorySync(opts.confirmStagingHistorySync ?? false);
    const target = installService();
    printSuccess(`Installed Answer Engine sync service at ${target.unitPath}`);
    printJson({
      data: {
        action: 'install-service',
        ...target,
        message: 'The sync daemon starts now and automatically after login.',
      },
    });
  } catch (error) {
    if (error instanceof ServicePlatformError || error instanceof ServiceCommandError || error instanceof UserConfigError || error instanceof HistorySyncPolicyError) {
      printError(error.message);
      process.exit(1);
    }
    throw error;
  }
}

function runUninstallServiceCommand(): void {
  try {
    const target = uninstallService();
    printSuccess(`Uninstalled Answer Engine sync service from ${target.unitPath}`);
    printJson({
      data: {
        action: 'uninstall-service',
        ...target,
        message: 'The sync daemon will no longer start automatically.',
      },
    });
  } catch (error) {
    if (error instanceof ServicePlatformError || error instanceof ServiceCommandError) {
      printError(error.message);
      process.exit(1);
    }
    throw error;
  }
}

function addSyncOptions(command: Command, includePolling: boolean): Command {
  command
    .option('--source <source>', `Sync source override: ${SUPPORTED_SYNC_SOURCES.join(', ')}`)
    .option('--path <path>', 'Source file, directory, or simple transcript glob override (repeatable)', collectPath)
    .option('--library <slug>', 'Library slug to attach imported items to')
    .option('--batch-size <n>', `Items per synchronous import request (max ${SYNC_IMPORT_MAX_BATCH_SIZE})`, String(DEFAULT_SYNC_BATCH_SIZE))
    .option('--concurrency <n>', `Concurrent history files to import (max ${SYNC_IMPORT_MAX_CONCURRENCY})`, String(DEFAULT_SYNC_CONCURRENCY))
    .option('--cursor-file <path>', 'Cursor JSON file override')
    .option('--confirm-staging-history-sync', 'Confirm access to real local history from staging');
  if (includePolling) {
    command.option('--poll-interval <seconds>', 'Seconds between daemon scans', String(DEFAULT_POLL_INTERVAL_SECONDS));
  }
  return command;
}

export function registerSyncCommands(program: Command): void {
  const sync = program
    .command('sync')
    .description('Continuously capture configured local sources into Answer Engine');

  addSyncOptions(
    sync
      .command('once')
      .description('Scan configured sources once, import changed content, and exit'),
    false
  ).action((opts: SyncCommandOptions) => runOnceCommand(opts));

  addSyncOptions(
    sync
      .command('run')
      .description('Run the polling sync daemon until interrupted'),
    true
  ).action((opts: SyncCommandOptions) => runDaemonCommand(opts));

  sync
    .command('install-service')
    .description('Install and start the per-user sync background service')
    .option('--confirm-staging-history-sync', 'Confirm access to real local history from staging')
    .action((opts: Pick<SyncCommandOptions, 'confirmStagingHistorySync'>) => runInstallServiceCommand(opts));

  sync
    .command('uninstall-service')
    .description('Stop and remove the per-user sync background service')
    .action(runUninstallServiceCommand);

  sync
    .command('status')
    .description('Show background service state and persisted sync cursors')
    .option('--source <source>', `Limit cursor status to: ${SUPPORTED_SYNC_SOURCES.join(', ')}`)
    .option('--cursor-file <path>', 'Cursor JSON file override')
    .action((opts: Pick<SyncCommandOptions, 'cursorFile' | 'source'>) => runStatusCommand(opts));
}
