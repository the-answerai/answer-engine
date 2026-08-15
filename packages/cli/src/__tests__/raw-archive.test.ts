import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RawArchiveManifestSchema,
  writeRawArchive,
} from '../sync/raw-archive.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'ae-raw-archive-'));
  tempDirs.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('writeRawArchive', () => {
  it('requires adapter versioning in the manifest contract', () => {
    expect(RawArchiveManifestSchema.safeParse({
      version: 1,
      created_at: '2026-08-10T20:00:00.000Z',
      adapter_name: 'test-adapter',
      files: [],
    }).success).toBe(false);
  });

  it('rejects archive manifest paths that can escape the immutable archive', () => {
    expect(RawArchiveManifestSchema.safeParse({
      version: 1,
      created_at: '2026-08-10T20:00:00.000Z',
      adapter_name: 'test-adapter',
      adapter_version: '1.0.0',
      files: [{
        path: '/private/source.jsonl', archive_path: '../source.jsonl', size: 1,
        mtime: '2026-08-10T20:00:00.000Z', sha256: 'a'.repeat(64),
        adapter_name: 'test-adapter', adapter_version: '1.0.0',
      }],
    }).success).toBe(false);
  });

  it('copies source bytes unchanged and writes a validated SHA-256 manifest', async () => {
    const root = makeTempDir();
    const sourcePath = join(root, 'source.jsonl');
    const archiveDir = join(root, 'archive');
    const sourceBytes = Buffer.from([0, 1, 2, 10, 13, 255]);
    writeFileSync(sourcePath, sourceBytes);

    const result = await writeRawArchive([sourcePath], {
      archiveDir,
      adapterName: 'test-adapter',
      adapterVersion: '2.1.0',
      createdAt: '2026-08-10T20:00:00.000Z',
    });

    const manifest = RawArchiveManifestSchema.parse(
      JSON.parse(readFileSync(result.manifestPath, 'utf8')),
    );
    const entry = manifest.files[0];
    expect(entry.path).toBe(sourcePath);
    expect(entry.adapter_name).toBe('test-adapter');
    expect(entry.adapter_version).toBe('2.1.0');
    expect(entry.sha256).toBe(createHash('sha256').update(sourceBytes).digest('hex'));
    expect(readFileSync(join(archiveDir, entry.archive_path))).toEqual(sourceBytes);
  });

  it('does not overwrite an existing immutable archive', async () => {
    const root = makeTempDir();
    const sourcePath = join(root, 'source.jsonl');
    const archiveDir = join(root, 'archive');
    writeFileSync(sourcePath, '{}\n');
    const options = {
      archiveDir,
      adapterName: 'test-adapter',
      adapterVersion: '1.0.0',
      createdAt: '2026-08-10T20:00:00.000Z',
    };

    await writeRawArchive([sourcePath], options);

    await expect(writeRawArchive([sourcePath], options)).rejects.toThrow(/already exists/i);
  });

  it('reuses a complete deterministic archive for the same source fingerprint', async () => {
    const root = makeTempDir();
    const sourcePath = join(root, 'source.jsonl');
    const previousHome = process.env.AE_HOME;
    process.env.AE_HOME = join(root, 'ae-home');
    writeFileSync(sourcePath, '{"type":"message"}\n');
    try {
      const first = await writeRawArchive([sourcePath], {
        adapterName: 'test-adapter', adapterVersion: '1.0.0',
        createdAt: '2026-08-10T20:00:00.000Z',
      });
      const resumed = await writeRawArchive([sourcePath], {
        adapterName: 'test-adapter', adapterVersion: '1.0.0',
        createdAt: '2026-08-11T20:00:00.000Z',
      });

      expect(resumed.archiveDir).toBe(first.archiveDir);
      expect(resumed.manifest).toEqual(first.manifest);
    } finally {
      if (previousHome === undefined) delete process.env.AE_HOME;
      else process.env.AE_HOME = previousHome;
    }
  });
});
