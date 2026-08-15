import { rm } from 'node:fs/promises';
import { Command } from 'commander';
import type { AnswerEngineClient, FolderRun, FolderSource } from '../api-client.js';
import { createClient, handleApiError } from '../client.js';
import { printError, printHeader, printJson, printSuccess } from '../output.js';
import {
  archiveApprovedFile,
  DEFAULT_FOLDER_MAX_FILE_BYTES,
  DEFAULT_FOLDER_MAX_TOTAL_BYTES,
  diffFolderPreview,
  folderArchiveDir,
  manifestMatchesServer,
  previewFolder,
  readFolderManifest,
  restatApprovedCandidate,
  updateFolderRegistry,
  writeFolderManifest,
  type FolderDiscoveryManifest,
  type FolderRegistryEntry,
} from '../sync/folder-ingestion.js';

interface AddOptions {
  include?: string[]; exclude: string[]; maxFileBytes: string; maxTotalBytes: string;
}
interface ResumeOptions { source: string; }
interface RemoveOptions { retention?: 'keep' | 'delete'; }

class FolderCommandError extends Error {}
function collect(value: string, previous: string[] = []): string[] { return [...previous, value]; }
function positiveBytes(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new FolderCommandError(`${flag} must be a positive integer`);
  return value;
}
function retentionChoice(value: string): 'keep' | 'delete' {
  if (value === 'keep' || value === 'delete') return value;
  throw new FolderCommandError('--retention must be keep or delete');
}
function waitForApprovalCheck(): Promise<void> { return new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000)); }

function registryEntry(source: FolderSource): FolderRegistryEntry {
  return { sourceId: source.id, rootPath: source.rootPath, manifestPath: source.latestRun?.manifestPath ?? source.manifestPath,
    includePatterns: source.includePatterns, excludePatterns: source.excludePatterns,
    maxFileBytes: source.maxFileBytes, maxTotalBytes: source.maxTotalBytes };
}

async function bindManifest(manifest: FolderDiscoveryManifest, source: FolderSource): Promise<FolderDiscoveryManifest> {
  const run = source.latestRun;
  if (!run) throw new FolderCommandError('Folder source has no preview run');
  const bound = { ...manifest, sourceId: source.id, runId: run.id };
  await writeFolderManifest(bound, run.manifestPath);
  return bound;
}

async function waitForApproval(client: AnswerEngineClient, source: FolderSource): Promise<FolderSource> {
  let current = source;
  while (current.latestRun?.status === 'previewed') {
    await waitForApprovalCheck();
    current = (await client.getFolderSource(source.id)).data;
  }
  return current;
}

function outcomeFromImport(result: { items?: Array<{ id: string; outcome?: 'created' | 'updated' | 'duplicate' }>; contentIds?: string[] }) {
  const row = result.items?.[0];
  const contentId = row?.id ?? result.contentIds?.[0];
  const outcome = row?.outcome === 'updated' ? 'updated' : row?.outcome === 'duplicate' ? 'duplicate' : 'imported';
  return { contentId, outcome } as const;
}

export async function applyApprovedFolder(client: AnswerEngineClient, source: FolderSource): Promise<FolderSource> {
  const run = source.latestRun;
  if (!run || !run.approvedAt || !['approved', 'running', 'cancel_requested'].includes(run.status)) {
    throw new FolderCommandError('Folder content cannot be read until its current inventory is approved');
  }
  const manifest = await readFolderManifest(run.manifestPath);
  if (!manifestMatchesServer(manifest, source)) throw new FolderCommandError('Local folder manifest does not exactly match the approved server inventory');
  if (run.status === 'approved') await client.startFolderRun(run.id);
  for (const serverItem of run.items.filter((item) => item.disposition === 'candidate' && item.outcome === 'pending')) {
    const current = (await client.getFolderSource(source.id)).data;
    if (current.latestRun?.status === 'cancel_requested') {
      await client.recordFolderEvent(run.id, { relativePath: serverItem.relativePath, outcome: 'skipped' });
      continue;
    }
    if (run.kind === 'refresh' && serverItem.change === 'unchanged') {
      await client.recordFolderEvent(run.id, { relativePath: serverItem.relativePath, outcome: 'duplicate' });
      continue;
    }
    const localItem = manifest.inventory.find((item) => item.relativePath === serverItem.relativePath);
    if (!localItem) throw new FolderCommandError(`Approved path is missing from local manifest: ${serverItem.relativePath}`);
    const condition = await restatApprovedCandidate(source.rootPath, localItem);
    if (condition !== 'unchanged') {
      await client.recordFolderEvent(run.id, { relativePath: localItem.relativePath, outcome: condition,
        ...(condition === 'changed' ? {} : {}) });
      continue;
    }
    try {
      const archive = await archiveApprovedFile(source.id, source.rootPath, localItem);
      const content = new TextDecoder('utf-8', { fatal: true }).decode(archive.bytes);
      const imported = (await client.submitSyncImport({
        items: [{
          title: localItem.relativePath, content_type: 'document', content, source: 'local_dir',
          source_identifier: `folder:${source.id}:${localItem.relativePath}`,
          source_data: { absolute_path: localItem.sourcePath, relative_path: localItem.relativePath },
          metadata: { folderSourceId: source.id, sourcePath: localItem.relativePath,
            sourceSha256: archive.sha256, adapterName: 'permissioned-local-folder', adapterVersion: '1.0.0' },
          raw_archive_manifest: { manifest_path: archive.manifestPath, sha256: archive.sha256,
            source_path: localItem.sourcePath, relative_path: localItem.relativePath },
        }],
        ...(source.libraryId ? { libraryId: source.libraryId } : {}),
      })).data;
      const result = outcomeFromImport(imported);
      if (!result.contentId) throw new Error('Import returned no content ID');
      await client.recordFolderEvent(run.id, { relativePath: localItem.relativePath, outcome: result.outcome,
        ...(result.outcome === 'duplicate' ? {} : { appliedSha256: archive.sha256, contentId: result.contentId,
          archiveManifestPath: archive.manifestPath }) });
    } catch {
      await client.recordFolderEvent(run.id, { relativePath: localItem.relativePath, outcome: 'failed',
        errorCode: 'FOLDER_IMPORT_FAILED', recoveryAction: `Run ae folders resume --source ${source.id}` });
    }
  }
  const completed = (await client.completeFolderRun(run.id)).data;
  await updateFolderRegistry(registryEntry(completed));
  return completed;
}

async function addFolder(root: string, options: AddOptions): Promise<void> {
  try {
    const client = createClient();
    const preview = await previewFolder(root, { includePatterns: options.include, excludePatterns: options.exclude,
      maxFileBytes: positiveBytes(options.maxFileBytes, '--max-file-bytes'),
      maxTotalBytes: positiveBytes(options.maxTotalBytes, '--max-total-bytes') });
    const manifestPath = await writeFolderManifest(preview);
    let source = (await client.registerFolderSource({ rootPath: preview.rootPath,
      includePatterns: preview.policy.includePatterns, excludePatterns: preview.policy.excludePatterns,
      maxFileBytes: preview.policy.maxFileBytes, maxTotalBytes: preview.policy.maxTotalBytes,
      symlinkPolicy: 'no_follow', manifestPath, inventory: preview.inventory })).data;
    await bindManifest(preview, source);
    printHeader('Local folder preview');
    printJson({ data: { sourceId: source.id, rootPath: source.rootPath, policy: preview.policy,
      counts: source.latestRun?.inventoryCounts, warnings: preview.inventory.filter((item) => item.disposition !== 'candidate'),
      approveAt: '/import', message: 'No file content has been ingested. Review and approve this exact inventory in Answer Engine.' } });
    source = await waitForApproval(client, source);
    if (source.latestRun?.status === 'canceled') return;
    const completed = await applyApprovedFolder(client, source);
    printJson({ data: completed });
    printSuccess(`Folder ingestion reconciled ${completed.latestRun?.counts.previewed ?? 0} preview rows`);
  } catch (error) { if (error instanceof FolderCommandError) { printError(error.message); process.exitCode = 1; return; } handleApiError(error); }
}

async function resumeFolder(options: ResumeOptions): Promise<void> {
  try {
    const client = createClient();
    const source = (await client.getFolderSource(options.source)).data;
    const completed = await applyApprovedFolder(client, source);
    printJson({ data: completed });
  } catch (error) { if (error instanceof FolderCommandError) { printError(error.message); process.exitCode = 1; return; } handleApiError(error); }
}

async function refreshFolder(options: ResumeOptions): Promise<void> {
  try {
    const client = createClient();
    let source = (await client.getFolderSource(options.source)).data;
    const previous = await readFolderManifest(source.latestRun?.manifestPath ?? source.manifestPath);
    const current = await previewFolder(source.rootPath, { includePatterns: source.includePatterns,
      excludePatterns: source.excludePatterns, maxFileBytes: source.maxFileBytes, maxTotalBytes: source.maxTotalBytes });
    const diff = await diffFolderPreview(previous, current);
    const manifestPath = await writeFolderManifest(diff);
    source = (await client.refreshFolderSource(source.id, { manifestPath, inventory: diff.inventory })).data;
    await bindManifest(diff, source);
    printJson({ data: { sourceId: source.id, runId: source.latestRun?.id,
      diff: source.latestRun?.inventoryCounts, approveAt: '/import', message: 'Review refresh differences before any changed file is read.' } });
    source = await waitForApproval(client, source);
    if (source.latestRun?.status === 'canceled') return;
    printJson({ data: await applyApprovedFolder(client, source) });
  } catch (error) { if (error instanceof FolderCommandError) { printError(error.message); process.exitCode = 1; return; } handleApiError(error); }
}

async function removeFolder(sourceId: string, options: RemoveOptions): Promise<void> {
  try {
    if (!options.retention) throw new FolderCommandError('--retention keep|delete is required');
    const client = createClient();
    const prepared = (await client.prepareFolderRemoval(sourceId, options.retention)).data;
    const contentIds = [...new Set(prepared.runs.flatMap((run) => run.items.map((item) => item.contentId).filter((id): id is string => Boolean(id))))];
    let archivesRemoved = 0;
    if (options.retention === 'delete') {
      await rm(folderArchiveDir(prepared.id), { recursive: true, force: true });
      archivesRemoved = prepared.runs.flatMap((run) => run.items).filter((item) => item.archiveManifestPath).length;
    }
    const removed = (await client.completeFolderRemoval(prepared.id, { retention: options.retention,
      deletedContentIds: options.retention === 'delete' ? contentIds : [], archivesRemoved, failures: [] })).data;
    await updateFolderRegistry(null, removed.id);
    printJson({ data: removed });
    printSuccess(`Removed folder source with ${options.retention} retention`);
  } catch (error) { if (error instanceof FolderCommandError) { printError(error.message); process.exitCode = 1; return; } handleApiError(error); }
}

export function registerFolderCommands(program: Command): void {
  const folders = program.command('folders').description('Preview and manage explicitly selected local folder sources');
  folders.command('add').description('Preview a selected folder, wait for approval, then ingest it').argument('<root>', 'Exact folder root selected by the user')
    .option('--include <glob>', 'Supported include glob (repeatable; defaults to Markdown and text)', collect)
    .option('--exclude <glob>', 'Ignore glob (repeatable)', collect, [])
    .option('--max-file-bytes <bytes>', 'Per-file safety limit', String(DEFAULT_FOLDER_MAX_FILE_BYTES))
    .option('--max-total-bytes <bytes>', 'Aggregate safety limit', String(DEFAULT_FOLDER_MAX_TOTAL_BYTES))
    .action(addFolder);
  folders.command('resume').description('Resume an approved or interrupted folder run')
    .requiredOption('--source <source-id>', 'Registered folder source UUID').action(resumeFolder);
  folders.command('refresh').description('Preview added, changed, unchanged, missing, and excluded paths before refresh')
    .requiredOption('--source <source-id>', 'Registered folder source UUID').action(refreshFolder);
  folders.command('remove').description('Remove a folder source with an explicit retention choice')
    .argument('<source-id>', 'Registered folder source UUID')
    .option('--retention <choice>', 'Required: keep memories/archives or delete both', retentionChoice)
    .action(removeFolder);
}
