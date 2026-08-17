import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RawArchiveCapacityError,
  RawArchiveManifestSchema,
  applyRawArchiveRetention,
  inspectRawArchive,
  planRawArchiveRetention,
  writeRawArchive,
} from '../sync/raw-archive.js';

const tempDirs: string[] = [];
const originalAeHome = process.env.AE_HOME;

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'ae-raw-archive-'));
  tempDirs.push(directory);
  return directory;
}

afterEach(() => {
  if (originalAeHome === undefined) delete process.env.AE_HOME;
  else process.env.AE_HOME = originalAeHome;
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

  it('reuses one content-addressed archive for repeated and concurrent writes', async () => {
    const root = makeTempDir();
    process.env.AE_HOME = join(root, 'ae-home');
    const sourcePath = join(root, 'source.jsonl');
    writeFileSync(sourcePath, '{"message":"bounded"}\n');
    const options = { adapterName: 'test-adapter', adapterVersion: '1.0.0' };

    const [first, second, third] = await Promise.all([
      writeRawArchive([sourcePath], options),
      writeRawArchive([sourcePath], options),
      writeRawArchive([sourcePath], options),
    ]);

    expect(second.archiveDir).toBe(first.archiveDir);
    expect(third.archiveDir).toBe(first.archiveDir);
    expect(readdirSync(join(root, 'ae-home', 'raw-archive'))).toEqual([
      expect.stringMatching(/^test-adapter-[a-f0-9]{64}$/),
    ]);
  });

  it('rejects an over-limit bundle before accepting any archive', async () => {
    const root = makeTempDir();
    process.env.AE_HOME = join(root, 'ae-home');
    const sourcePath = join(root, 'source.jsonl');
    writeFileSync(sourcePath, '12345678901');

    await expect(writeRawArchive([sourcePath], {
      adapterName: 'test-adapter',
      adapterVersion: '1.0.0',
      limits: { maxBundleBytes: 10, maxTotalBytes: 100, minFreeBytes: 0 },
    })).rejects.toBeInstanceOf(RawArchiveCapacityError);

    expect(readdirSync(join(root, 'ae-home', 'raw-archive'))).toEqual([]);
  });

  it('counts existing archive bytes and fails closed at the total ceiling', async () => {
    const root = makeTempDir();
    process.env.AE_HOME = join(root, 'ae-home');
    const archiveRoot = join(root, 'ae-home', 'raw-archive');
    mkdirSync(join(archiveRoot, 'existing'), { recursive: true });
    writeFileSync(join(archiveRoot, 'existing', 'payload.bin'), '1234567890');
    const sourcePath = join(root, 'source.jsonl');
    writeFileSync(sourcePath, 'x');

    await expect(writeRawArchive([sourcePath], {
      adapterName: 'test-adapter',
      adapterVersion: '1.0.0',
      limits: { maxBundleBytes: 100, maxTotalBytes: 10, minFreeBytes: 0 },
    })).rejects.toThrow(/total limit/i);

    expect(readdirSync(archiveRoot)).toEqual(['existing']);
  });

  it('preserves the configured free-space reserve without leaving a partial archive', async () => {
    const root = makeTempDir();
    process.env.AE_HOME = join(root, 'ae-home');
    const sourcePath = join(root, 'source.jsonl');
    writeFileSync(sourcePath, 'bounded');

    await expect(writeRawArchive([sourcePath], {
      adapterName: 'test-adapter',
      adapterVersion: '1.0.0',
      limits: {
        maxBundleBytes: 100,
        maxTotalBytes: 1024 * 1024,
        minFreeBytes: Number.MAX_SAFE_INTEGER,
      },
    })).rejects.toThrow(/free-space reserve/i);

    expect(readdirSync(join(root, 'ae-home', 'raw-archive'))).toEqual([]);
  });

  it('rejects a tampered content-addressed manifest that escapes its archive directory', async () => {
    const root = makeTempDir();
    process.env.AE_HOME = join(root, 'ae-home');
    const sourcePath = join(root, 'source.jsonl');
    writeFileSync(sourcePath, 'evidence');
    const options = { adapterName: 'test-adapter', adapterVersion: '1.0.0' };
    const archive = await writeRawArchive([sourcePath], options);
    const manifest = JSON.parse(readFileSync(archive.manifestPath, 'utf8')) as {
      files: Array<{ archive_path: string }>;
    };
    manifest.files[0]!.archive_path = '../../../source.jsonl';
    writeFileSync(archive.manifestPath, `${JSON.stringify(manifest)}\n`);

    await expect(writeRawArchive([sourcePath], options)).rejects.toThrow(/remain inside/i);
  });

  it('plans and applies only unreferenced archive deletion after exact confirmation', async () => {
    const root = makeTempDir();
    process.env.AE_HOME = join(root, 'ae-home');
    const firstSource = join(root, 'first.jsonl');
    const secondSource = join(root, 'second.jsonl');
    writeFileSync(firstSource, 'first');
    writeFileSync(secondSource, 'second');
    const first = await writeRawArchive([firstSource], {
      adapterName: 'test-adapter', adapterVersion: '1.0.0', createdAt: '2026-08-01T00:00:00.000Z',
    });
    const second = await writeRawArchive([secondSource], {
      adapterName: 'test-adapter', adapterVersion: '1.0.0', createdAt: '2026-08-02T00:00:00.000Z',
    });

    const inventory = await inspectRawArchive();
    const plan = planRawArchiveRetention(inventory, [first.manifestPath], 0);
    expect(plan.candidates.map((candidate) => candidate.manifestPath)).toEqual([second.manifestPath]);
    expect(plan.referencedManifestPaths).toEqual([first.manifestPath]);

    await expect(applyRawArchiveRetention(plan, 'wrong-token')).rejects.toThrow(/confirmation/i);
    expect(existsSync(second.archiveDir)).toBe(true);

    const applied = await applyRawArchiveRetention(plan, plan.confirmationToken);
    expect(applied.removedArchives).toBe(1);
    expect(existsSync(first.archiveDir)).toBe(true);
    expect(existsSync(second.archiveDir)).toBe(false);
  });
});
