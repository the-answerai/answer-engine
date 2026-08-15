import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { resolveAeHome } from '../home.js';
import { globMatches } from './sources/local-dir.js';

export const FOLDER_ADAPTER_NAME = 'permissioned-local-folder';
export const FOLDER_ADAPTER_VERSION = '1.0.0';
export const DEFAULT_FOLDER_INCLUDE = ['**/*.md', '**/*.markdown', '**/*.txt'] as const;
export const DEFAULT_FOLDER_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_FOLDER_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const BINARY_SAMPLE_BYTES = 8 * 1024;
const HARD_IGNORES = new Set(['.git', 'node_modules']);
const SUPPORTED_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);

export type FolderDisposition = 'candidate' | 'excluded' | 'hidden' | 'unsupported' | 'binary'
  | 'too_large' | 'access_denied' | 'symlink' | 'aggregate_limit' | 'missing';

export interface FolderInventoryItem {
  sourcePath: string;
  relativePath: string;
  fileType?: string;
  byteSize: number;
  modifiedAt?: string;
  disposition: FolderDisposition;
  reason: string;
  metadataFingerprint?: string;
  change?: 'added' | 'changed' | 'unchanged' | 'missing' | 'excluded';
}

export interface FolderPreviewPolicy {
  includePatterns?: string[];
  excludePatterns?: string[];
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

export interface FolderDiscoveryManifest {
  version: 1;
  sourceId?: string;
  runId?: string;
  rootPath: string;
  createdAt: string;
  policy: Required<FolderPreviewPolicy> & { symlinkPolicy: 'no_follow' };
  inventory: FolderInventoryItem[];
}

const ManifestSchema: z.ZodType<FolderDiscoveryManifest> = z.object({
  version: z.literal(1), sourceId: z.string().uuid().optional(), runId: z.string().uuid().optional(),
  rootPath: z.string().min(1), createdAt: z.string().datetime(),
  policy: z.object({ includePatterns: z.array(z.string().min(1)), excludePatterns: z.array(z.string().min(1)),
    maxFileBytes: z.number().int().positive(), maxTotalBytes: z.number().int().positive(),
    symlinkPolicy: z.literal('no_follow') }).strict(),
  inventory: z.array(z.object({ sourcePath: z.string().min(1), relativePath: z.string().min(1),
    fileType: z.string().optional(), byteSize: z.number().int().nonnegative(), modifiedAt: z.string().datetime().optional(),
    disposition: z.enum(['candidate', 'excluded', 'hidden', 'unsupported', 'binary', 'too_large', 'access_denied', 'symlink', 'aggregate_limit', 'missing']),
    reason: z.string().min(1), metadataFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    change: z.enum(['added', 'changed', 'unchanged', 'missing', 'excluded']).optional() }).strict()),
}).strict();

function slash(path: string): string { return path.split(sep).join('/'); }
function hash(value: Buffer | string): string { return createHash('sha256').update(value).digest('hex'); }
function metadataFingerprint(relativePath: string, size: number, mtimeMs: number): string {
  return hash(JSON.stringify({ relativePath, size, mtimeMs }));
}
function permissionDenied(error: unknown): boolean {
  return ['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '');
}

async function isBinary(path: string): Promise<boolean> {
  const handle = await open(path, 'r');
  try {
    const sample = Buffer.alloc(BINARY_SAMPLE_BYTES);
    const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
    if (sample.subarray(0, bytesRead).includes(0)) return true;
    try { new TextDecoder('utf-8', { fatal: true }).decode(sample.subarray(0, bytesRead)); return false; }
    catch { return true; }
  } finally { await handle.close(); }
}

export async function previewFolder(rootInput: string, input: FolderPreviewPolicy = {}): Promise<FolderDiscoveryManifest> {
  if (!rootInput.trim()) throw new Error('A folder root must be selected explicitly');
  const rootPath = resolve(rootInput);
  const rootStat = await lstat(rootPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (!rootStat?.isDirectory()) throw new Error(`Selected folder is unavailable: ${rootPath}`);
  if (rootStat.isSymbolicLink()) throw new Error('Selected folder cannot be a symlink');
  const policy = {
    includePatterns: input.includePatterns?.length ? input.includePatterns : [...DEFAULT_FOLDER_INCLUDE],
    excludePatterns: input.excludePatterns ?? [],
    maxFileBytes: input.maxFileBytes ?? DEFAULT_FOLDER_MAX_FILE_BYTES,
    maxTotalBytes: input.maxTotalBytes ?? DEFAULT_FOLDER_MAX_TOTAL_BYTES,
    symlinkPolicy: 'no_follow' as const,
  };
  let candidateBytes = 0;
  const inventory: FolderInventoryItem[] = [];

  async function walk(directory: string): Promise<void> {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      const relativePath = slash(relative(rootPath, directory)) || '.';
      inventory.push({ sourcePath: directory, relativePath, byteSize: 0,
        disposition: permissionDenied(error) ? 'access_denied' : 'missing',
        reason: permissionDenied(error) ? 'Directory permission denied' : 'Directory became unavailable' });
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const sourcePath = join(directory, entry.name);
      const relativePath = slash(relative(rootPath, sourcePath));
      if (entry.isSymbolicLink()) {
        inventory.push({ sourcePath, relativePath, byteSize: 0, disposition: 'symlink', reason: 'Symlinks are never followed' });
        continue;
      }
      if (entry.name.startsWith('.')) {
        inventory.push({ sourcePath, relativePath, byteSize: 0, disposition: 'hidden', reason: 'Hidden paths are excluded' });
        continue;
      }
      if (entry.isDirectory()) {
        if (HARD_IGNORES.has(entry.name)) {
          inventory.push({ sourcePath, relativePath, byteSize: 0, disposition: 'excluded', reason: 'Hard-ignored directory' });
        } else await walk(sourcePath);
        continue;
      }
      let fileStat;
      try { fileStat = await lstat(sourcePath); }
      catch (error) {
        inventory.push({ sourcePath, relativePath, byteSize: 0,
          disposition: permissionDenied(error) ? 'access_denied' : 'missing',
          reason: permissionDenied(error) ? 'File permission denied' : 'File became unavailable' });
        continue;
      }
      if (!fileStat.isFile()) {
        inventory.push({ sourcePath, relativePath, byteSize: 0, disposition: 'unsupported', reason: 'Not a regular file' });
        continue;
      }
      const base = { sourcePath, relativePath, byteSize: fileStat.size,
        modifiedAt: fileStat.mtime.toISOString(), fileType: extname(entry.name).toLowerCase() || 'unknown' };
      if (policy.excludePatterns.some((pattern) => globMatches(relativePath, pattern))) {
        inventory.push({ ...base, disposition: 'excluded', reason: 'Matched a configured ignore pattern', change: 'excluded' });
      } else if (!policy.includePatterns.some((pattern) => globMatches(relativePath, pattern))
        || !SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        inventory.push({ ...base, disposition: 'unsupported', reason: 'Unsupported file type or include pattern' });
      } else if (fileStat.size > policy.maxFileBytes) {
        inventory.push({ ...base, disposition: 'too_large', reason: `Exceeds ${policy.maxFileBytes} byte per-file limit` });
      } else {
        let binary: boolean;
        try { binary = await isBinary(sourcePath); }
        catch (error) {
          inventory.push({ ...base, disposition: permissionDenied(error) ? 'access_denied' : 'missing',
            reason: permissionDenied(error) ? 'File permission denied during bounded sample' : 'File became unavailable during bounded sample' });
          continue;
        }
        if (binary) inventory.push({ ...base, disposition: 'binary', reason: 'Bounded sample classified this as binary' });
        else if (candidateBytes + fileStat.size > policy.maxTotalBytes) {
          inventory.push({ ...base, disposition: 'aggregate_limit', reason: `Would exceed ${policy.maxTotalBytes} byte aggregate limit` });
        } else {
          candidateBytes += fileStat.size;
          inventory.push({ ...base, disposition: 'candidate', reason: 'Supported text file within configured limits',
            metadataFingerprint: metadataFingerprint(relativePath, fileStat.size, fileStat.mtimeMs), change: 'added' });
        }
      }
    }
  }
  await walk(rootPath);
  return ManifestSchema.parse({ version: 1, rootPath, createdAt: new Date().toISOString(), policy, inventory });
}

export function folderManifestDir(): string { return join(resolveAeHome(), 'data', 'folder-ingestion'); }
export function folderArchiveDir(sourceId: string): string {
  return join(resolveAeHome(), 'raw-archive', 'folders', z.string().uuid().parse(sourceId));
}
export function folderRegistryPath(): string { return join(folderManifestDir(), 'sources.json'); }

export interface FolderRegistryEntry {
  sourceId: string; rootPath: string; manifestPath: string; includePatterns: string[];
  excludePatterns: string[]; maxFileBytes: number; maxTotalBytes: number;
}

const RegistrySchema = z.object({ version: z.literal(1), sources: z.array(z.object({
  sourceId: z.string().uuid(), rootPath: z.string().min(1), manifestPath: z.string().min(1),
  includePatterns: z.array(z.string()), excludePatterns: z.array(z.string()),
  maxFileBytes: z.number().int().positive(), maxTotalBytes: z.number().int().positive(),
}).strict()) }).strict();

export async function readFolderRegistry(): Promise<FolderRegistryEntry[]> {
  try { return RegistrySchema.parse(JSON.parse(await readFile(folderRegistryPath(), 'utf8'))).sources; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function updateFolderRegistry(entry: FolderRegistryEntry | null, removeSourceId?: string): Promise<void> {
  const directory = folderManifestDir();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const sources = (await readFolderRegistry()).filter((item) => item.sourceId !== (removeSourceId ?? entry?.sourceId));
  if (entry) sources.push(entry);
  sources.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  const target = folderRegistryPath();
  const staging = `${target}.staging-${randomUUID()}`;
  await writeFile(staging, `${JSON.stringify({ version: 1, sources }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(staging, target);
  await chmod(target, 0o600);
}

function assertInside(parent: string, candidate: string): void {
  const rel = relative(resolve(parent), resolve(candidate));
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) return;
  throw new Error(`Path must remain inside ${parent}`);
}

export async function writeFolderManifest(manifest: FolderDiscoveryManifest, fileName = `${randomUUID()}.json`): Promise<string> {
  const directory = folderManifestDir();
  const manifestPath = join(directory, basename(fileName));
  assertInside(directory, manifestPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const staging = `${manifestPath}.staging-${randomUUID()}`;
  await writeFile(staging, `${JSON.stringify(ManifestSchema.parse(manifest), null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await rename(staging, manifestPath);
  await chmod(manifestPath, 0o600);
  return manifestPath;
}

export async function readFolderManifest(manifestPath: string): Promise<FolderDiscoveryManifest> {
  assertInside(folderManifestDir(), manifestPath);
  const handle = await open(manifestPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try { return ManifestSchema.parse(JSON.parse(await handle.readFile('utf8'))); }
  finally { await handle.close(); }
}

export function manifestMatchesServer(local: FolderDiscoveryManifest, server: {
  id: string; rootPath: string; manifestPath: string; latestRun: { id: string; manifestPath: string; items: Array<{
    sourcePath: string; relativePath: string; byteSize: number; modifiedAt?: string | null;
    disposition: FolderDisposition; metadataFingerprint?: string | null;
  }> } | null;
}): boolean {
  if (!server.latestRun || local.sourceId !== server.id || local.runId !== server.latestRun.id
    || resolve(local.rootPath) !== resolve(server.rootPath)) return false;
  const approvedRow = (item: {
    sourcePath: string; relativePath: string; byteSize: number; modifiedAt?: string | null;
    disposition: FolderDisposition; metadataFingerprint?: string | null;
  }): string => JSON.stringify({ sourcePath: item.sourcePath, relativePath: item.relativePath,
    byteSize: item.byteSize, modifiedAt: item.modifiedAt ?? null, disposition: item.disposition,
    metadataFingerprint: item.metadataFingerprint ?? null });
  const localRows = local.inventory.map(approvedRow).sort();
  const serverRows = server.latestRun.items.map(approvedRow).sort();
  return localRows.length === serverRows.length && localRows.every((row, index) => row === serverRows[index]);
}

export async function restatApprovedCandidate(rootPath: string, item: FolderInventoryItem): Promise<'unchanged' | 'changed' | 'missing'> {
  const expected = resolve(rootPath, item.relativePath);
  assertInside(rootPath, expected);
  let current;
  try { current = await lstat(expected); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || permissionDenied(error)) return 'missing';
    throw error;
  }
  if (!current.isFile() || current.isSymbolicLink() || !item.metadataFingerprint) return 'changed';
  return metadataFingerprint(item.relativePath, current.size, current.mtimeMs) === item.metadataFingerprint ? 'unchanged' : 'changed';
}

export async function archiveApprovedFile(sourceId: string, rootPath: string, item: FolderInventoryItem) {
  const sourcePath = resolve(rootPath, item.relativePath);
  assertInside(rootPath, sourcePath);
  const handle = await open(sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let bytes: Buffer;
  try {
    const before = await handle.stat();
    if (!before.isFile() || !item.metadataFingerprint
      || metadataFingerprint(item.relativePath, before.size, before.mtimeMs) !== item.metadataFingerprint) {
      throw new Error('Approved folder source changed before archive');
    }
    bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs) throw new Error('Approved folder source changed during archive');
  } finally { await handle.close(); }
  const sha256 = hash(bytes);
  const archiveRoot = folderArchiveDir(sourceId);
  const directory = join(archiveRoot, hash(item.relativePath), sha256);
  const archivedPath = join(directory, 'source.bin');
  const manifestPath = join(directory, 'manifest.json');
  assertInside(archiveRoot, directory);
  try {
    const existing = JSON.parse(await readFile(manifestPath, 'utf8')) as { sha256?: string; archived_path?: string };
    const existingBytes = await readFile(join(directory, existing.archived_path ?? 'source.bin'));
    if (existing.sha256 !== sha256 || hash(existingBytes) !== sha256) throw new Error('Folder archive integrity check failed');
    return { bytes: existingBytes, sha256, manifestPath };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const staging = `${directory}.staging-${randomUUID()}`;
  await mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    await writeFile(join(staging, 'source.bin'), bytes, { flag: 'wx', mode: 0o600 });
    await writeFile(join(staging, 'manifest.json'), `${JSON.stringify({
      version: 1, source_path: sourcePath, relative_path: item.relativePath, archived_path: 'source.bin',
      size: bytes.byteLength, sha256, adapter_name: FOLDER_ADAPTER_NAME,
      adapter_version: FOLDER_ADAPTER_VERSION, created_at: new Date().toISOString(),
    }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
    await rename(staging, directory);
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
  return { bytes, sha256, manifestPath };
}

export async function diffFolderPreview(previous: FolderDiscoveryManifest, next: FolderDiscoveryManifest): Promise<FolderDiscoveryManifest> {
  const before = new Map(previous.inventory.map((item) => [item.relativePath, item]));
  const seen = new Set<string>();
  const inventory = next.inventory.map((item) => {
    seen.add(item.relativePath);
    const old = before.get(item.relativePath);
    const change = item.disposition !== 'candidate' ? 'excluded'
      : !old ? 'added'
      : old.metadataFingerprint === item.metadataFingerprint ? 'unchanged' : 'changed';
    return { ...item, change } as FolderInventoryItem;
  });
  for (const item of previous.inventory) {
    if (!seen.has(item.relativePath) && item.disposition === 'candidate') {
      inventory.push({ ...item, byteSize: 0, modifiedAt: undefined, metadataFingerprint: undefined,
        disposition: 'missing', reason: 'Previously imported path is now missing', change: 'missing' });
    }
  }
  inventory.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return ManifestSchema.parse({ ...next, sourceId: previous.sourceId, inventory });
}
