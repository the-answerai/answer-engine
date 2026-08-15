import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';
import { registerFolderCommands } from '../commands/folders.js';
import {
  archiveApprovedFile,
  diffFolderPreview,
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
});
