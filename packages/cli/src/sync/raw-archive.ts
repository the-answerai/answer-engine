import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { rawArchiveDir } from '../home.js';

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

function defaultArchiveDir(createdAt: string): string {
  const timestamp = createdAt.replace(/[:.]/g, '-');
  return join(rawArchiveDir(), `${timestamp}-${randomUUID()}`);
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
  const archiveDir = options.archiveDir ?? defaultArchiveDir(createdAt);
  const manifestPath = join(archiveDir, 'manifest.json');

  await mkdir(dirname(archiveDir), { recursive: true });
  try {
    await mkdir(archiveDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Raw archive already exists: ${archiveDir}`);
    }
    throw error;
  }

  try {
    await mkdir(join(archiveDir, 'files'));
    const files: RawFileManifestEntry[] = [];

    for (const [index, sourcePath] of sourcePaths.entries()) {
      const [sourceBytes, sourceStat] = await Promise.all([
        readFile(sourcePath),
        stat(sourcePath),
      ]);
      if (!sourceStat.isFile()) throw new Error(`Raw archive source is not a file: ${sourcePath}`);

      const archivePath = `files/${String(index).padStart(6, '0')}-${safeBaseName(sourcePath)}`;
      await writeFile(join(archiveDir, archivePath), sourceBytes, { flag: 'wx' });
      files.push({
        path: sourcePath,
        archive_path: archivePath,
        size: sourceBytes.byteLength,
        mtime: sourceStat.mtime.toISOString(),
        sha256: createHash('sha256').update(sourceBytes).digest('hex'),
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
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    return { archiveDir, manifestPath, manifest };
  } catch (error) {
    await rm(archiveDir, { recursive: true, force: true });
    throw error;
  }
}
