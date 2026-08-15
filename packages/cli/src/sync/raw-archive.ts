import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, type Stats } from 'node:fs';
import { appendFile, lstat, mkdir, open, opendir, readFile, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { logsDir, rawArchiveDir } from '../home.js';

export const RAW_ARCHIVE_MANIFEST_VERSION = 1 as const;

const NonEmptyStringSchema = z.string().trim().min(1);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i, 'must be a SHA-256 hex digest');

export const RawFileManifestEntrySchema = z.object({
  path: NonEmptyStringSchema,
  archive_path: NonEmptyStringSchema,
  size: z.number().int().nonnegative(),
  mtime: z.string().datetime(),
  sha256: Sha256Schema,
  adapter_name: NonEmptyStringSchema,
  adapter_version: NonEmptyStringSchema,
}).strict();

export const RawArchiveManifestSchema = z.object({
  version: z.literal(RAW_ARCHIVE_MANIFEST_VERSION),
  created_at: z.string().datetime(),
  adapter_name: NonEmptyStringSchema,
  adapter_version: NonEmptyStringSchema,
  files: z.array(RawFileManifestEntrySchema),
}).strict();

export type RawFileManifestEntry = z.infer<typeof RawFileManifestEntrySchema>;
export type RawArchiveManifest = z.infer<typeof RawArchiveManifestSchema>;

export const DEFAULT_RAW_ARCHIVE_MAX_BUNDLE_BYTES = 256 * 1024 * 1024;
export const DEFAULT_RAW_ARCHIVE_MAX_TOTAL_BYTES = 10 * 1024 * 1024 * 1024;
export const DEFAULT_RAW_ARCHIVE_MIN_FREE_BYTES = 10 * 1024 * 1024 * 1024;

export interface RawArchiveLimits {
  maxBundleBytes: number;
  maxTotalBytes: number;
  minFreeBytes: number;
}

export class RawArchiveCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RawArchiveCapacityError';
  }
}

export interface WriteRawArchiveOptions {
  archiveDir?: string;
  adapterName: string;
  adapterVersion: string;
  createdAt?: string;
  limits?: Partial<RawArchiveLimits>;
}

export interface WriteRawArchiveResult {
  archiveDir: string;
  manifestPath: string;
  manifest: RawArchiveManifest;
}

export interface RawArchiveInventoryEntry {
  archiveDir: string;
  manifestPath: string;
  createdAt: string;
  bytes: number;
}

export interface RawArchiveInventory {
  root: string;
  totalBytes: number;
  archives: RawArchiveInventoryEntry[];
  failures: Array<{ path: string; error: string }>;
}

export interface RawArchiveRetentionPlan {
  version: 1;
  root: string;
  targetBytes: number;
  totalBytes: number;
  retainedBytes: number;
  blockedBytes: number;
  referencedManifestPaths: string[];
  candidates: RawArchiveInventoryEntry[];
  confirmationToken: string;
}

export interface RawArchiveRetentionResult {
  removedArchives: number;
  removedBytes: number;
  retainedBytes: number;
}

export function attachRawArchiveManifest<
  T extends { provider_metadata_json: Record<string, unknown> },
>(conversations: readonly T[], archive: WriteRawArchiveResult): T[] {
  const rawArchiveManifest = {
    manifest_path: archive.manifestPath,
    ...archive.manifest,
  };
  return conversations.map((conversation) => ({
    ...conversation,
    provider_metadata_json: {
      ...conversation.provider_metadata_json,
      raw_archive_manifest: rawArchiveManifest,
    },
  }));
}

function safeBaseName(path: string): string {
  const safe = basename(path).replace(/[^a-zA-Z0-9._-]/g, '_');
  return safe || 'source.bin';
}

interface SourceSnapshot {
  path: string;
  size: number;
  mtime: string;
  mtimeMs: number;
  dev: number | bigint;
  ino: number | bigint;
  sha256: string;
}

const READ_BUFFER_BYTES = 1024 * 1024;
let archiveWriteQueue: Promise<void> = Promise.resolve();

function byteLimit(name: string, fallback: number, allowZero: boolean): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new RawArchiveCapacityError(`${name} must be ${allowZero ? 'a non-negative' : 'a positive'} integer byte count`);
  }
  return parsed;
}

function archiveLimits(overrides: Partial<RawArchiveLimits> = {}): RawArchiveLimits {
  const limits = {
    maxBundleBytes: overrides.maxBundleBytes
      ?? byteLimit('AE_RAW_ARCHIVE_MAX_BUNDLE_BYTES', DEFAULT_RAW_ARCHIVE_MAX_BUNDLE_BYTES, false),
    maxTotalBytes: overrides.maxTotalBytes
      ?? byteLimit('AE_RAW_ARCHIVE_MAX_TOTAL_BYTES', DEFAULT_RAW_ARCHIVE_MAX_TOTAL_BYTES, false),
    minFreeBytes: overrides.minFreeBytes
      ?? byteLimit('AE_RAW_ARCHIVE_MIN_FREE_BYTES', DEFAULT_RAW_ARCHIVE_MIN_FREE_BYTES, true),
  };
  if (!Number.isSafeInteger(limits.maxBundleBytes) || limits.maxBundleBytes <= 0
    || !Number.isSafeInteger(limits.maxTotalBytes) || limits.maxTotalBytes <= 0
    || !Number.isSafeInteger(limits.minFreeBytes) || limits.minFreeBytes < 0) {
    throw new RawArchiveCapacityError('Raw archive limits must be safe integer byte counts');
  }
  return limits;
}

function isWithin(parent: string, candidate: string): boolean {
  const child = relative(resolve(parent), resolve(candidate));
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child));
}

function sourceChanged(before: SourceSnapshot, after: Stats): boolean {
  return before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs;
}

async function snapshotSource(sourcePath: string): Promise<SourceSnapshot> {
  const handle = await open(sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`Raw archive source is not a regular file: ${sourcePath}`);
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
    let position = 0;
    while (position < before.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const snapshot: SourceSnapshot = {
      path: sourcePath,
      size: position,
      mtime: before.mtime.toISOString(),
      mtimeMs: before.mtimeMs,
      dev: before.dev,
      ino: before.ino,
      sha256: digest.digest('hex'),
    };
    const after = await handle.stat();
    if (position !== before.size || sourceChanged(snapshot, after)) {
      throw new Error(`Raw archive source changed while being inspected: ${sourcePath}`);
    }
    return snapshot;
  } finally {
    await handle.close();
  }
}

function bundleFingerprint(
  snapshots: readonly SourceSnapshot[],
  adapterName: string,
  adapterVersion: string,
): string {
  const digest = createHash('sha256');
  digest.update(adapterName);
  digest.update('\0');
  digest.update(adapterVersion);
  digest.update('\0');
  for (const source of snapshots) {
    digest.update(source.path);
    digest.update('\0');
    digest.update(source.sha256);
    digest.update('\0');
  }
  return digest.digest('hex');
}

async function copySnapshot(source: SourceSnapshot, targetPath: string): Promise<void> {
  const sourceHandle = await open(source.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  const targetHandle = await open(targetPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  try {
    const before = await sourceHandle.stat();
    if (!before.isFile() || sourceChanged(source, before)) {
      throw new Error(`Raw archive source changed before copy: ${source.path}`);
    }
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
    let position = 0;
    while (position < source.size) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, Math.min(buffer.length, source.size - position), position);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
      let offset = 0;
      while (offset < bytesRead) {
        const { bytesWritten } = await targetHandle.write(buffer, offset, bytesRead - offset, null);
        offset += bytesWritten;
      }
      position += bytesRead;
    }
    const after = await sourceHandle.stat();
    if (position !== source.size || sourceChanged(source, after) || digest.digest('hex') !== source.sha256) {
      throw new Error(`Raw archive source changed during copy: ${source.path}`);
    }
    await targetHandle.sync();
  } finally {
    await Promise.allSettled([sourceHandle.close(), targetHandle.close()]);
  }
}

async function directoryBytes(root: string, stopAfter: number): Promise<number> {
  let directory;
  try {
    directory = await opendir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let total = 0;
  for await (const entry of directory) {
    if (entry.name === '.write.lock') continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(path, stopAfter - total);
    else if (entry.isFile()) total += (await lstat(path)).size;
    if (total > stopAfter) break;
  }
  return total;
}

async function availableBytes(path: string): Promise<number> {
  const stats = await statfs(path);
  return Number(stats.bavail) * Number(stats.bsize);
}

async function validateExistingArchive(
  archiveDir: string,
  snapshots: readonly SourceSnapshot[],
  adapterName: string,
  adapterVersion: string,
): Promise<WriteRawArchiveResult> {
  const manifestPath = join(archiveDir, 'manifest.json');
  const manifest = RawArchiveManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
  if (manifest.adapter_name !== adapterName || manifest.adapter_version !== adapterVersion
    || manifest.files.length !== snapshots.length) {
    throw new Error(`Content-addressed raw archive does not match requested bundle: ${archiveDir}`);
  }
  for (const [index, source] of snapshots.entries()) {
    const entry = manifest.files[index];
    if (!entry || entry.path !== source.path || entry.size !== source.size || entry.sha256 !== source.sha256) {
      throw new Error(`Content-addressed raw archive manifest failed integrity validation: ${archiveDir}`);
    }
    const archivedPath = join(archiveDir, entry.archive_path);
    if (!isWithin(archiveDir, archivedPath)) {
      throw new Error(`Raw archive file path must remain inside its archive directory: ${entry.archive_path}`);
    }
    const archived = await snapshotSource(archivedPath);
    if (archived.size !== entry.size || archived.sha256 !== entry.sha256) {
      throw new Error(`Content-addressed raw archive bytes failed integrity validation: ${archiveDir}`);
    }
  }
  return { archiveDir, manifestPath, manifest };
}

async function acquireArchiveLock(archiveRoot: string): Promise<() => Promise<void>> {
  const lockPath = join(archiveRoot, '.write.lock');
  const create = async (): Promise<void> => {
    const handle = await open(lockPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
  };
  try {
    await create();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let stale = false;
    try {
      const record = JSON.parse(await readFile(lockPath, 'utf8')) as { pid?: unknown };
      if (typeof record.pid === 'number' && Number.isSafeInteger(record.pid)) {
        try { process.kill(record.pid, 0); } catch (processError) {
          stale = (processError as NodeJS.ErrnoException).code === 'ESRCH';
        }
      }
    } catch {
      // An unreadable lock fails closed; it may belong to an active writer.
    }
    if (!stale) throw new Error(`Another raw archive writer is active: ${lockPath}`);
    await rm(lockPath, { force: true });
    await create();
  }
  return async () => { await rm(lockPath, { force: true }); };
}

async function serializeArchiveWrite<T>(operation: () => Promise<T>): Promise<T> {
  const result = archiveWriteQueue.then(operation, operation);
  archiveWriteQueue = result.then(() => undefined, () => undefined);
  return result;
}

export async function inspectRawArchive(root: string = rawArchiveDir()): Promise<RawArchiveInventory> {
  const archiveRoot = resolve(root);
  const archives: RawArchiveInventoryEntry[] = [];
  const failures: Array<{ path: string; error: string }> = [];
  let directory;
  try {
    directory = await opendir(archiveRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { root: archiveRoot, totalBytes: 0, archives, failures };
    }
    throw error;
  }
  for await (const entry of directory) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'folders') continue;
    const archiveDir = join(archiveRoot, entry.name);
    const manifestPath = join(archiveDir, 'manifest.json');
    try {
      const manifest = RawArchiveManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
      archives.push({
        archiveDir,
        manifestPath,
        createdAt: manifest.created_at,
        bytes: await directoryBytes(archiveDir, Number.MAX_SAFE_INTEGER),
      });
    } catch (error) {
      failures.push({ path: archiveDir, error: error instanceof Error ? error.message : String(error) });
    }
  }
  archives.sort((left, right) => left.createdAt.localeCompare(right.createdAt)
    || left.manifestPath.localeCompare(right.manifestPath));
  return {
    root: archiveRoot,
    totalBytes: await directoryBytes(archiveRoot, Number.MAX_SAFE_INTEGER),
    archives,
    failures,
  };
}

function retentionToken(input: Omit<RawArchiveRetentionPlan, 'confirmationToken'>): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export function planRawArchiveRetention(
  inventory: RawArchiveInventory,
  referencedManifestPaths: readonly string[],
  targetBytes: number,
): RawArchiveRetentionPlan {
  if (!Number.isSafeInteger(targetBytes) || targetBytes < 0) {
    throw new RawArchiveCapacityError('Raw archive retention target must be a non-negative integer byte count');
  }
  const references = [...new Set(referencedManifestPaths.map((path) => resolve(path)))].sort();
  const referenced = new Set(references);
  const candidates: RawArchiveInventoryEntry[] = [];
  let retainedBytes = inventory.totalBytes;
  for (const archive of inventory.archives) {
    if (retainedBytes <= targetBytes) break;
    if (referenced.has(resolve(archive.manifestPath))) continue;
    candidates.push(archive);
    retainedBytes = Math.max(0, retainedBytes - archive.bytes);
  }
  const withoutToken = {
    version: 1 as const,
    root: resolve(inventory.root),
    targetBytes,
    totalBytes: inventory.totalBytes,
    retainedBytes,
    blockedBytes: Math.max(0, retainedBytes - targetBytes),
    referencedManifestPaths: references,
    candidates,
  };
  return { ...withoutToken, confirmationToken: retentionToken(withoutToken) };
}

export async function applyRawArchiveRetention(
  plan: RawArchiveRetentionPlan,
  confirmationToken: string,
): Promise<RawArchiveRetentionResult> {
  const { confirmationToken: _storedToken, ...withoutToken } = plan;
  const expectedToken = retentionToken(withoutToken);
  if (confirmationToken !== expectedToken || plan.confirmationToken !== expectedToken) {
    throw new Error('Raw archive retention confirmation token does not match the current plan');
  }
  await mkdir(plan.root, { recursive: true, mode: 0o700 });
  const releaseLock = await acquireArchiveLock(plan.root);
  try {
    const currentPlan = planRawArchiveRetention(
      await inspectRawArchive(plan.root),
      plan.referencedManifestPaths,
      plan.targetBytes,
    );
    if (currentPlan.confirmationToken !== expectedToken) {
      throw new Error('Raw archive retention plan is stale; generate and review a fresh plan');
    }
    const auditPath = join(logsDir(), 'raw-archive-retention.jsonl');
    await mkdir(dirname(auditPath), { recursive: true, mode: 0o700 });
    await appendFile(auditPath, `${JSON.stringify({
      event: 'raw_archive_retention_authorized',
      at: new Date().toISOString(),
      confirmationToken: expectedToken,
      targetBytes: plan.targetBytes,
      candidates: plan.candidates.map((candidate) => ({
        manifestPath: candidate.manifestPath, bytes: candidate.bytes,
      })),
    })}\n`, { encoding: 'utf8', mode: 0o600 });

    let removedArchives = 0;
    let removedBytes = 0;
    const referenced = new Set(plan.referencedManifestPaths.map((path) => resolve(path)));
    for (const candidate of plan.candidates) {
      if (!isWithin(plan.root, candidate.archiveDir) || resolve(candidate.archiveDir) === resolve(plan.root)
        || resolve(candidate.manifestPath) !== resolve(join(candidate.archiveDir, 'manifest.json'))
        || referenced.has(resolve(candidate.manifestPath))) {
        throw new Error(`Unsafe raw archive retention candidate: ${candidate.archiveDir}`);
      }
      const archiveStat = await lstat(candidate.archiveDir);
      if (!archiveStat.isDirectory() || archiveStat.isSymbolicLink()) {
        throw new Error(`Raw archive retention candidate is not a regular directory: ${candidate.archiveDir}`);
      }
      RawArchiveManifestSchema.parse(JSON.parse(await readFile(candidate.manifestPath, 'utf8')));
      await rm(candidate.archiveDir, { recursive: true, force: false });
      removedArchives += 1;
      removedBytes += candidate.bytes;
    }
    return {
      removedArchives,
      removedBytes,
      retainedBytes: Math.max(0, plan.totalBytes - removedBytes),
    };
  } finally {
    await releaseLock();
  }
}

export async function writeRawArchive(
  sourcePaths: readonly string[],
  options: WriteRawArchiveOptions,
): Promise<WriteRawArchiveResult> {
  return serializeArchiveWrite(async () => {
    if (sourcePaths.length === 0) throw new Error('Raw archive requires at least one source file');
    if (new Set(sourcePaths.map((path) => resolve(path))).size !== sourcePaths.length) {
      throw new Error('Raw archive source paths must be unique');
    }

    const createdAt = options.createdAt ?? new Date().toISOString();
    const adapter = z.object({
      adapter_name: NonEmptyStringSchema,
      adapter_version: NonEmptyStringSchema,
      created_at: z.string().datetime(),
    }).parse({
      adapter_name: options.adapterName,
      adapter_version: options.adapterVersion,
      created_at: createdAt,
    });
    const limits = archiveLimits(options.limits);
    const archiveRoot = options.archiveDir ? dirname(resolve(options.archiveDir)) : rawArchiveDir();
    await mkdir(archiveRoot, { recursive: true, mode: 0o700 });
    for (const sourcePath of sourcePaths) {
      if (isWithin(rawArchiveDir(), sourcePath)) {
        throw new Error(`Raw archive cannot archive its own contents: ${sourcePath}`);
      }
    }
    const releaseLock = await acquireArchiveLock(archiveRoot);
    try {
      const snapshots: SourceSnapshot[] = [];
      let bundleBytes = 0;
      for (const sourcePath of sourcePaths) {
        const snapshot = await snapshotSource(sourcePath);
        bundleBytes += snapshot.size;
        if (bundleBytes > limits.maxBundleBytes) {
          throw new RawArchiveCapacityError(
            `Raw archive bundle exceeds ${limits.maxBundleBytes} byte per-bundle limit`,
          );
        }
        snapshots.push(snapshot);
      }

      const fingerprint = bundleFingerprint(snapshots, adapter.adapter_name, adapter.adapter_version);
      const archiveDir = options.archiveDir
        ? resolve(options.archiveDir)
        : join(archiveRoot, `${safeBaseName(adapter.adapter_name)}-${fingerprint}`);
      const manifestPath = join(archiveDir, 'manifest.json');
      if (!isWithin(archiveRoot, archiveDir)) throw new Error('Raw archive target must remain inside its archive root');

      try {
        await lstat(archiveDir);
        if (options.archiveDir) throw new Error(`Raw archive already exists: ${archiveDir}`);
        return await validateExistingArchive(
          archiveDir, snapshots, adapter.adapter_name, adapter.adapter_version,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }

      const existingBytes = await directoryBytes(archiveRoot, limits.maxTotalBytes);
      const requiredBytes = bundleBytes + 64 * 1024;
      if (existingBytes + requiredBytes > limits.maxTotalBytes) {
        throw new RawArchiveCapacityError(
          `Raw archive total limit would be exceeded (${existingBytes} existing + ${requiredBytes} required > ${limits.maxTotalBytes})`,
        );
      }
      const freeBytes = await availableBytes(archiveRoot);
      if (freeBytes - requiredBytes < limits.minFreeBytes) {
        throw new RawArchiveCapacityError(
          `Raw archive write would breach the ${limits.minFreeBytes} byte free-space reserve`,
        );
      }

      const stagingDir = join(archiveRoot, `.staging-${randomUUID()}`);
      try {
        await mkdir(join(stagingDir, 'files'), { recursive: true, mode: 0o700 });
        const files: RawFileManifestEntry[] = [];
        for (const [index, source] of snapshots.entries()) {
          const archivePath = `files/${String(index).padStart(6, '0')}-${safeBaseName(source.path)}`;
          await copySnapshot(source, join(stagingDir, archivePath));
          files.push({
            path: source.path,
            archive_path: archivePath,
            size: source.size,
            mtime: source.mtime,
            sha256: source.sha256,
            adapter_name: adapter.adapter_name,
            adapter_version: adapter.adapter_version,
          });
        }
        const manifest = RawArchiveManifestSchema.parse({
          version: RAW_ARCHIVE_MANIFEST_VERSION,
          created_at: adapter.created_at,
          adapter_name: adapter.adapter_name,
          adapter_version: adapter.adapter_version,
          files,
        });
        await writeFile(join(stagingDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
          encoding: 'utf8', mode: 0o600, flag: 'wx',
        });
        try {
          await rename(stagingDir, archiveDir);
        } catch (error) {
          if (!options.archiveDir && (error as NodeJS.ErrnoException).code === 'EEXIST') {
            await rm(stagingDir, { recursive: true, force: true });
            return validateExistingArchive(
              archiveDir, snapshots, adapter.adapter_name, adapter.adapter_version,
            );
          }
          throw error;
        }
        return { archiveDir, manifestPath, manifest };
      } catch (error) {
        await rm(stagingDir, { recursive: true, force: true });
        throw error;
      }
    } finally {
      await releaseLock();
    }
  });
}
