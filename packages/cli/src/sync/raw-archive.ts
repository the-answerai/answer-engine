import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { rawArchiveDir } from '../home.js';

export const RAW_ARCHIVE_MANIFEST_VERSION = 1 as const;

const NonEmptyStringSchema = z.string().trim().min(1);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i, 'must be a SHA-256 hex digest');
const ArchivePathSchema = z.string().regex(
  /^files\/[a-zA-Z0-9._-]+$/,
  'must remain within the archive files directory',
);

export const RawFileManifestEntrySchema = z.object({
  path: NonEmptyStringSchema,
  archive_path: ArchivePathSchema,
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
  source_fingerprint: Sha256Schema.optional(),
  files: z.array(RawFileManifestEntrySchema),
}).strict();

export type RawFileManifestEntry = z.infer<typeof RawFileManifestEntrySchema>;
export type RawArchiveManifest = z.infer<typeof RawArchiveManifestSchema>;

export interface WriteRawArchiveOptions {
  archiveDir?: string;
  adapterName: string;
  adapterVersion: string;
  createdAt?: string;
}

export interface WriteRawArchiveResult {
  archiveDir: string;
  manifestPath: string;
  manifest: RawArchiveManifest;
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

function defaultArchiveDir(_adapterName: string, sourceFingerprint: string): string {
  return join(rawArchiveDir(), sourceFingerprint);
}

async function existingArchive(
  archiveDir: string,
  expected: readonly RawFileManifestEntry[],
): Promise<WriteRawArchiveResult | null> {
  const manifestPath = join(archiveDir, 'manifest.json');
  let parsed: RawArchiveManifest;
  try {
    parsed = RawArchiveManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Raw archive manifest is invalid at ${manifestPath}`);
  }
  if (
    parsed.files.length !== expected.length
    || parsed.files.some((entry, index) => {
      const wanted = expected[index];
      return !wanted || entry.path !== wanted.path || entry.sha256 !== wanted.sha256
        || entry.adapter_name !== wanted.adapter_name || entry.adapter_version !== wanted.adapter_version;
    })
  ) {
    throw new Error(`Raw archive manifest does not match the source fingerprint at ${manifestPath}`);
  }
  for (const entry of parsed.files) {
    const bytes = await readFile(join(archiveDir, entry.archive_path));
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (bytes.byteLength !== entry.size || digest !== entry.sha256) {
      throw new Error(`Raw archive integrity check failed at ${manifestPath}`);
    }
  }
  return { archiveDir, manifestPath, manifest: parsed };
}

export async function writeRawArchive(
  sourcePaths: readonly string[],
  options: WriteRawArchiveOptions,
): Promise<WriteRawArchiveResult> {
  if (sourcePaths.length === 0) throw new Error('Raw archive requires at least one source file');

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
  const snapshots = await Promise.all(sourcePaths.map(async (sourcePath, index) => {
    const [sourceBytes, sourceStat] = await Promise.all([readFile(sourcePath), stat(sourcePath)]);
    if (!sourceStat.isFile()) throw new Error(`Raw archive source is not a file: ${sourcePath}`);
    return {
      sourceBytes,
      entry: {
        path: sourcePath,
        archive_path: `files/${String(index).padStart(6, '0')}-${safeBaseName(sourcePath)}`,
        size: sourceBytes.byteLength,
        mtime: sourceStat.mtime.toISOString(),
        sha256: createHash('sha256').update(sourceBytes).digest('hex'),
        adapter_name: adapter.adapter_name,
        adapter_version: adapter.adapter_version,
      } satisfies RawFileManifestEntry,
    };
  }));
  const files = snapshots.map((snapshot) => snapshot.entry);
  const sourceFingerprint = createHash('sha256').update(JSON.stringify({
    adapter_name: adapter.adapter_name,
    adapter_version: adapter.adapter_version,
    files: files.map(({ path, sha256 }) => ({ path, sha256 })),
  })).digest('hex');
  const archiveDir = options.archiveDir ?? defaultArchiveDir(adapter.adapter_name, sourceFingerprint);
  const manifestPath = join(archiveDir, 'manifest.json');
  await mkdir(dirname(archiveDir), { recursive: true });

  if (options.archiveDir) {
    try { await mkdir(archiveDir); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Raw archive already exists: ${archiveDir}`);
      throw error;
    }
  } else {
    const existing = await existingArchive(archiveDir, files);
    if (existing) return existing;
    await rm(archiveDir, { recursive: true, force: true });
  }

  const writeDir = options.archiveDir ? archiveDir : `${archiveDir}.staging-${randomUUID()}`;
  try {
    if (!options.archiveDir) {
      await rm(writeDir, { recursive: true, force: true });
      await mkdir(writeDir);
    }
    await mkdir(join(writeDir, 'files'));
    for (const snapshot of snapshots) {
      await writeFile(join(writeDir, snapshot.entry.archive_path), snapshot.sourceBytes, { flag: 'wx' });
    }
    const manifest = RawArchiveManifestSchema.parse({
      version: RAW_ARCHIVE_MANIFEST_VERSION,
      created_at: adapter.created_at,
      adapter_name: adapter.adapter_name,
      adapter_version: adapter.adapter_version,
      source_fingerprint: sourceFingerprint,
      files,
    });
    await writeFile(join(writeDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8', flag: 'wx',
    });
    if (!options.archiveDir) {
      try { await rename(writeDir, archiveDir); }
      catch (error) {
        await rm(writeDir, { recursive: true, force: true });
        const raced = await existingArchive(archiveDir, files);
        if (raced) return raced;
        throw error;
      }
    }
    return { archiveDir, manifestPath, manifest };
  } catch (error) {
    await rm(writeDir, { recursive: true, force: true });
    throw error;
  }
}
