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
import { configYamlPath } from '../home.js';
import {
  assertFirstImportManifestMatchesSession,
  mergeApprovedHistorySources,
  firstImportItemMatchesDiscovery,
  registerFirstImportDiscovery,
} from '../sync/first-import.js';
import type {
  AnswerEngineClient,
  FirstImportEventRequest,
  FirstImportSession,
} from '../api-client.js';
import {
  applyRawArchiveRetention,
  DEFAULT_RAW_ARCHIVE_MAX_TOTAL_BYTES,
  inspectRawArchive,
  planRawArchiveRetention,
  type RawArchiveRetentionPlan,
} from '../sync/raw-archive.js';

const DEFAULT_SYNC_BATCH_SIZE = 25;
const DEFAULT_POLL_INTERVAL_SECONDS = 300;

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

interface FirstImportCommandOptions {
  resume?: string;
  batchSize: string;
  cursorFile?: string;
  confirmStagingHistorySync?: boolean;
}
interface ArchiveCommandOptions { targetBytes: string; confirm?: string; }

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

function parseNonNegativeInteger(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new UserInputError(`${name} must be a non-negative integer`);
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
    `deferred=${summary.deferredFiles} failed=${summary.failedItems} ` +
    `parseErrors=${summary.parseErrors} archiveWritten=${summary.archiveBytesWritten} ` +
    `archiveReused=${summary.archiveBytesReused}`
  );
}

function waitForNextApprovalCheck(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1_000));
}

async function waitForFirstImportApproval(
  client: Pick<AnswerEngineClient, 'getFirstImport'>,
  initial: FirstImportSession,
): Promise<FirstImportSession> {
  let session = initial;
  while (session.status === 'discovered') {
    await waitForNextApprovalCheck();
    session = (await client.getFirstImport(session.id)).data;
  }
  return session;
}

function recoveryAction(sessionId: string): string {
  return `Open /import, choose Retry, then run ae sync first-import --resume ${sessionId}`;
}

async function recordSafeFailure(
  client: Pick<AnswerEngineClient, 'recordFirstImportEvent'>,
  sessionId: string,
  item: FirstImportSession['items'][number],
  errorCode: string,
  action: string = recoveryAction(sessionId),
): Promise<void> {
  await client.recordFirstImportEvent(sessionId, {
    sourceId: item.sourceId,
    fingerprint: item.fingerprint,
    outcome: 'failed',
    errorCode,
    recoveryAction: action,
  });
}

async function runFirstImportItem(
  client: AnswerEngineClient,
  sessionId: string,
  item: FirstImportSession['items'][number],
  options: Pick<FirstImportCommandOptions, 'batchSize' | 'cursorFile'>,
): Promise<void> {
  let summary: SyncRunSummary;
  try {
    if (!await firstImportItemMatchesDiscovery(item)) {
      await recordSafeFailure(
        client,
        sessionId,
        item,
        'SOURCE_CHANGED_SINCE_APPROVAL',
        'Run ae sync first-import to review and approve a fresh source inventory.',
      );
      return;
    }
    summary = await runSyncOnce({
      sourceId: item.sourceId,
      paths: [item.sourcePath],
      cursorFile: options.cursorFile,
      batchSize: parseBatchSize(options.batchSize),
      concurrency: 1,
      client,
      onWarning: () => undefined,
      inventoryOnly: true,
    });
  } catch {
    await recordSafeFailure(client, sessionId, item, 'SOURCE_READ_FAILED');
    return;
  }
  let event: FirstImportEventRequest;
  if (summary.filesScanned === 0) {
    event = {
      sourceId: item.sourceId, fingerprint: item.fingerprint, outcome: 'failed',
      errorCode: 'SOURCE_UNAVAILABLE', recoveryAction: recoveryAction(sessionId),
    };
  } else if (summary.failedItems > 0 || summary.parseErrors > 0) {
    event = {
      sourceId: item.sourceId, fingerprint: item.fingerprint, outcome: 'failed',
      errorCode: summary.failedItems > 0 ? 'IMPORT_REJECTED' : 'SOURCE_PARSE_FAILED',
      recoveryAction: recoveryAction(sessionId),
    };
  } else if (summary.turnsImported > 0) {
    const [archiveManifestPath] = summary.archiveManifestPaths;
    if (!archiveManifestPath || summary.contentIds.length === 0) {
      event = {
        sourceId: item.sourceId, fingerprint: item.fingerprint, outcome: 'failed',
        errorCode: 'ARCHIVE_INTEGRITY_FAILED', recoveryAction: recoveryAction(sessionId),
      };
    } else {
      event = {
        sourceId: item.sourceId, fingerprint: item.fingerprint, outcome: 'imported',
        contentIds: summary.contentIds, archiveManifestPath,
      };
    }
  } else if (summary.duplicateItems > 0) {
    event = { sourceId: item.sourceId, fingerprint: item.fingerprint, outcome: 'duplicate' };
  } else {
    event = { sourceId: item.sourceId, fingerprint: item.fingerprint, outcome: 'skipped' };
  }
  await client.recordFirstImportEvent(sessionId, event);
}

async function runFirstImportCommand(opts: FirstImportCommandOptions): Promise<void> {
  try {
    assertCommandHistorySync(opts.confirmStagingHistorySync ?? false);
    const client = createClient();
    let session = opts.resume
      ? (await client.getFirstImport(opts.resume)).data
      : await registerFirstImportDiscovery(client);
    try {
      assertFirstImportManifestMatchesSession(session);
    } catch {
      throw new UserInputError(
        'The local first-import discovery manifest is missing or does not match this session. Run ae sync first-import to create and approve a fresh inventory.',
      );
    }
    printHeader('First agent-history import');
    if (session.status === 'discovered'
      && !session.sources.some((source) => source.availability === 'available')) {
      printJson({ data: session });
      throw new UserInputError('No supported agent history is currently available. Review source status on /import, then retry discovery.');
    }
    if (session.status === 'discovered') {
      printJson({ data: {
        sessionId: session.id,
        status: session.status,
        approveAt: '/import',
        message: 'Review source paths and exclusions in Answer Engine, then approve the sources to import.',
      } });
      session = await waitForFirstImportApproval(client, session);
    }
    if (session.status === 'canceled' || session.status === 'completed') {
      printJson({ data: session });
      return;
    }
    if (session.status === 'failed') {
      throw new UserInputError(recoveryAction(session.id));
    }
    if (!session.approvedAt || session.selectedSourceIds.length === 0) {
      throw new UserInputError('First import has not been approved. Open /import and select at least one source.');
    }
    mergeApprovedHistorySources(configYamlPath(), session.selectedSourceIds);
    if (session.status === 'approved') session = (await client.startFirstImport(session.id)).data;
    for (const item of session.items.filter((candidate) => (
      candidate.outcome === 'pending' && session.selectedSourceIds.includes(candidate.sourceId)
    ))) {
      const latest = (await client.getFirstImport(session.id)).data;
      if (latest.status === 'cancel_requested') {
        await client.recordFirstImportEvent(session.id, {
          sourceId: item.sourceId, fingerprint: item.fingerprint, outcome: 'skipped',
        });
        continue;
      }
      await runFirstImportItem(client, session.id, item, opts);
    }
    session = (await client.completeFirstImport(session.id)).data;
    printJson({ data: session });
    if (session.status === 'failed') process.exitCode = 1;
    else printSuccess(`First import reconciled ${session.counts.discovered} discovered histories`);
  } catch (error) {
    if (error instanceof UserInputError || error instanceof UserConfigError || error instanceof HistorySyncPolicyError) {
      printError(error.message);
      process.exitCode = 1;
      return;
    }
    handleApiError(error);
  }
}

function resolveCommandSources(opts: SyncCommandOptions): ConfiguredSyncSource[] {
  const hasExplicitPaths = opts.path !== undefined && opts.path.length > 0;
  if (opts.source !== undefined || hasExplicitPaths) {
    const sourceId = parseSource(opts.source ?? 'claude-code');
    if (sourceId === 'local_dir') {
      throw new UserInputError('Direct local_dir sync is disabled. Use ae folders add <root> so the inventory is approved before content is read.');
    }
    return [{
      sourceId,
      ...(hasExplicitPaths ? { paths: opts.path } : {}),
      ...(opts.library ? { librarySlug: opts.library } : {}),
    }];
  }

  const configured = resolveSyncSourcesFromConfig();
  if (configured.some((source) => source.sourceId === 'local_dir')) {
    throw new UserInputError('Configured local_dir sync requires migration to ae folders add <root>; implicit folder reads are disabled.');
  }
  return configured.map((source) => ({
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

async function buildArchiveRetentionPlan(options: ArchiveCommandOptions): Promise<RawArchiveRetentionPlan> {
  const targetBytes = parseNonNegativeInteger(options.targetBytes, '--target-bytes');
  const references = (await createClient().getRawArchiveReferences()).data.manifestPaths;
  return planRawArchiveRetention(await inspectRawArchive(), references, targetBytes);
}

async function runArchivePlanCommand(options: ArchiveCommandOptions): Promise<void> {
  try {
    printJson({ data: await buildArchiveRetentionPlan(options) });
  } catch (error) {
    if (error instanceof UserInputError) {
      printError(error.message);
      process.exitCode = 1;
      return;
    }
    handleApiError(error);
  }
}

async function runArchivePruneCommand(options: ArchiveCommandOptions): Promise<void> {
  try {
    const service = queryServiceStatus();
    if (service.running) {
      throw new UserInputError('Stop the background sync service before pruning raw archives');
    }
    const plan = await buildArchiveRetentionPlan(options);
    if (plan.candidates.length === 0) {
      printJson({ data: { plan, removedArchives: 0, removedBytes: 0 } });
      printSuccess('No unreferenced raw archives need removal');
      return;
    }
    if (!options.confirm || options.confirm !== plan.confirmationToken) {
      printJson({ data: plan });
      throw new UserInputError(
        'Review this plan, then rerun archive prune with --confirm <confirmationToken>',
      );
    }
    const result = await applyRawArchiveRetention(plan, options.confirm);
    printJson({ data: { plan, ...result } });
    printSuccess(`Removed ${result.removedArchives} unreferenced raw archive${result.removedArchives === 1 ? '' : 's'}`);
  } catch (error) {
    if (error instanceof UserInputError) {
      printError(error.message);
      process.exitCode = 1;
      return;
    }
    handleApiError(error);
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

  sync
    .command('first-import')
    .description('Discover, approve, resumably import, and reconcile supported agent history')
    .option('--resume <session-id>', 'Resume an approved or interrupted first-import session')
    .option('--batch-size <n>', `Items per synchronous import request (max ${SYNC_IMPORT_MAX_BATCH_SIZE})`, String(DEFAULT_SYNC_BATCH_SIZE))
    .option('--cursor-file <path>', 'Cursor JSON file override')
    .option('--confirm-staging-history-sync', 'Confirm access to real local history from staging')
    .action((opts: FirstImportCommandOptions) => runFirstImportCommand(opts));

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

  const archive = sync
    .command('archive')
    .description('Inspect and explicitly prune unreferenced raw source archives');
  archive
    .command('plan')
    .description('Preview reference-aware raw archive retention without deleting files')
    .option('--target-bytes <bytes>', 'Desired maximum archive size after pruning', String(DEFAULT_RAW_ARCHIVE_MAX_TOTAL_BYTES))
    .action((opts: ArchiveCommandOptions) => runArchivePlanCommand(opts));
  archive
    .command('prune')
    .description('Apply an unchanged retention plan after stopping sync and confirming its token')
    .option('--target-bytes <bytes>', 'Desired maximum archive size after pruning', String(DEFAULT_RAW_ARCHIVE_MAX_TOTAL_BYTES))
    .option('--confirm <token>', 'Exact confirmation token printed by archive plan')
    .action((opts: ArchiveCommandOptions) => runArchivePruneCommand(opts));
}
