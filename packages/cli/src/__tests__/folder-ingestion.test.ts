import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';
import { registerFolderCommands } from '../commands/folders.js';
import {
  archiveApprovedFile,
  diffFolderPreview,
  manifestMatchesServer,
  previewFolder,
  readFolderManifest,
  restatApprovedCandidate,
  writeFolderManifest,
} from '../sync/folder-ingestion.js';

const temporaryPaths: string[] = [];
async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'ae-folder-preview-'));
  temporaryPaths.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  delete process.env.AE_HOME;
});

describe('permissioned folder ingestion', () => {
  it('uses only explicitly configured include globs when provided', () => {
    const program = new Command();
    registerFolderCommands(program);
    const folders = program.commands.find((command) => command.name() === 'folders');
    const add = folders?.commands.find((command) => command.name() === 'add');
    expect(add).toBeDefined();
    add!.parseOptions(['--include', 'notes/**/*.txt', '--include', 'decisions/*.md']);
    expect(add!.opts().include).toEqual(['notes/**/*.txt', 'decisions/*.md']);
  });

  it('reports exclusions deterministically without following symlinks', async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, 'good.md'), 'approved text');
    await writeFile(join(root, '.secret.md'), 'hidden');
    await writeFile(join(root, 'image.png'), Buffer.from([0, 1, 2]));
    await writeFile(join(root, 'binary.txt'), Buffer.from([65, 0, 66]));
    await writeFile(join(root, 'large.txt'), 'x'.repeat(20));
    await writeFile(join(root, 'ignored.txt'), 'ignored');
    await symlink(join(root, 'good.md'), join(root, 'linked.md'));

    const preview = await previewFolder(root, {
      excludePatterns: ['ignored.txt'], maxFileBytes: 16, maxTotalBytes: 100,
    });
    expect(preview.inventory.map(({ relativePath, disposition }) => [relativePath, disposition])).toEqual([
      ['.secret.md', 'hidden'], ['binary.txt', 'binary'], ['good.md', 'candidate'],
      ['ignored.txt', 'excluded'], ['image.png', 'unsupported'], ['large.txt', 'too_large'],
      ['linked.md', 'symlink'],
    ]);
  });

  it('enforces aggregate limits and detects apply-time changes before reading', async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, 'a.txt'), '12345');
    await writeFile(join(root, 'b.txt'), '67890');
    const preview = await previewFolder(root, { maxTotalBytes: 5 });
    expect(preview.inventory.map((item) => item.disposition)).toEqual(['candidate', 'aggregate_limit']);
    const candidate = preview.inventory[0];
    expect(candidate).toBeDefined();
    expect(await restatApprovedCandidate(root, candidate!)).toBe('unchanged');
    await writeFile(join(root, 'a.txt'), 'changed bytes');
    expect(await restatApprovedCandidate(root, candidate!)).toBe('changed');
  });

  it('stores owner-only manifests inside the active channel home and rejects traversal', async () => {
    const root = await temporaryDirectory();
    const aeHome = await temporaryDirectory();
    process.env.AE_HOME = aeHome;
    await writeFile(join(root, 'note.md'), 'hello');
    const preview = await previewFolder(root);
    const manifestPath = await writeFolderManifest(preview, 'preview.json');
    expect((await readFolderManifest(manifestPath)).inventory).toEqual(preview.inventory);
    await expect(readFolderManifest(join(aeHome, '..', 'outside.json'))).rejects.toThrow('must remain inside');
  });

  it('archives approved bytes with a matching SHA-256 and reports refresh differences', async () => {
    const root = await temporaryDirectory();
    const aeHome = await temporaryDirectory();
    process.env.AE_HOME = aeHome;
    await writeFile(join(root, 'note.md'), 'version one');
    const previous = await previewFolder(root);
    const archived = await archiveApprovedFile('11111111-1111-4111-8111-111111111111', root, previous.inventory[0]!);
    expect(archived.sha256).toBe(createHash('sha256').update('version one').digest('hex'));
    expect(createHash('sha256').update(await readFile(join(archived.manifestPath, '..', 'source.bin'))).digest('hex')).toBe(archived.sha256);
    await writeFile(join(root, 'note.md'), 'version two');
    await writeFile(join(root, 'added.txt'), 'new');
    const diff = await diffFolderPreview(previous, await previewFolder(root));
    expect(Object.fromEntries(diff.inventory.map((item) => [item.relativePath, item.change]))).toEqual({
      'added.txt': 'added', 'note.md': 'changed',
    });
  });

  it('matches approved manifests against hydrated server rows without trusting response-only fields', async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, 'a.md'), 'alpha');
    await writeFile(join(root, 'b.md'), 'beta');
    const sourceId = '11111111-1111-4111-8111-111111111111';
    const runId = '22222222-2222-4222-8222-222222222222';
    const manifest = { ...await previewFolder(root), sourceId, runId };
    const hydratedItems = [...manifest.inventory].reverse().map((item) => ({
      ...item,
      outcome: 'pending',
      appliedSha256: null,
      contentId: null,
      archiveManifestPath: null,
      errorCode: null,
      recoveryAction: null,
    }));
    const server = {
      id: sourceId,
      rootPath: root,
      manifestPath: '/channel/source.json',
      latestRun: { id: runId, manifestPath: '/channel/run.json', items: hydratedItems },
    };

    expect(manifestMatchesServer(manifest, server)).toBe(true);
    expect(manifestMatchesServer(manifest, {
      ...server,
      latestRun: { ...server.latestRun, items: hydratedItems.map((item, index) => (
        index === 0 ? { ...item, byteSize: item.byteSize + 1 } : item
      )) },
    })).toBe(false);
  });

  it('keeps source-specific manifests when different paths have identical bytes', async () => {
    const root = await temporaryDirectory();
    const aeHome = await temporaryDirectory();
    process.env.AE_HOME = aeHome;
    await writeFile(join(root, 'a.md'), 'same bytes');
    await writeFile(join(root, 'b.md'), 'same bytes');
    const preview = await previewFolder(root);
    const sourceId = '11111111-1111-4111-8111-111111111111';

    const first = await archiveApprovedFile(sourceId, root, preview.inventory[0]!);
    const second = await archiveApprovedFile(sourceId, root, preview.inventory[1]!);
    const firstManifest = JSON.parse(await readFile(first.manifestPath, 'utf8')) as { relative_path: string };
    const secondManifest = JSON.parse(await readFile(second.manifestPath, 'utf8')) as { relative_path: string };

    expect(first.sha256).toBe(second.sha256);
    expect(first.manifestPath).not.toBe(second.manifestPath);
    expect([firstManifest.relative_path, secondManifest.relative_path]).toEqual(['a.md', 'b.md']);
  });

  it('refuses archive manifests that redirect reads outside their archive directory', async () => {
    const root = await temporaryDirectory();
    const aeHome = await temporaryDirectory();
    process.env.AE_HOME = aeHome;
    await writeFile(join(root, 'note.md'), 'approved bytes');
    const preview = await previewFolder(root);
    const sourceId = randomUUID();
    const archived = await archiveApprovedFile(sourceId, root, preview.inventory[0]!);
    const outsidePath = join(aeHome, 'outside.bin');
    await writeFile(outsidePath, 'approved bytes');
    await writeFile(archived.manifestPath, `${JSON.stringify({
      sha256: archived.sha256,
      archived_path: relative(join(archived.manifestPath, '..'), outsidePath),
    })}\n`);

    await expect(archiveApprovedFile(sourceId, root, preview.inventory[0]!))
      .rejects.toThrow(/archive manifest/i);
  });
});
