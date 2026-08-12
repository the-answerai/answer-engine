import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  globMatches,
  localDirSource,
  type LocalDirSkip,
} from '../sync/sources/local-dir.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ae-local-dir-source-'));
  tempDirs.push(dir);
  return dir;
}

function writeText(path: string, content: string): void {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('globMatches', () => {
  it.each([
    ['note.md', '**/*.md', true],
    ['nested/note.md', '**/*.md', true],
    ['nested/note.txt', '**/*.md', false],
    ['drafts/note.md', 'drafts/**', true],
    ['drafts/nested/note.md', 'drafts/**', true],
    ['notes/readme.txt', '**/*.{md,txt}', true],
    ['notes/readme.rst', '**/*.{md,txt}', false],
  ])('matches %s against %s as %s', (path, glob, expected) => {
    expect(globMatches(path, glob)).toBe(expected);
  });
});

describe('localDirSource', () => {
  it('discovers default document files while respecting excludes and hard skips', async () => {
    const root = makeTempDir();
    writeText(join(root, 'note.md'), '# Root note');
    writeText(join(root, 'notes', 'readme.txt'), 'Nested note');
    writeText(join(root, 'notes', 'ignore.log'), 'Not included by default');
    writeText(join(root, 'drafts', 'private.md'), 'Excluded');
    writeText(join(root, '.hidden.md'), 'Hidden');
    writeText(join(root, '.private', 'secret.md'), 'Hidden directory');
    writeText(join(root, 'node_modules', 'package', 'readme.md'), 'Dependency');
    writeText(join(root, '.git', 'objects', 'object.md'), 'Git internals');

    const files = await localDirSource.discover({
      paths: [root],
      exclude: ['drafts/**'],
    });

    expect(files.map((file) => file.relativePath)).toEqual([
      'note.md',
      'notes/readme.txt',
    ]);
  });

  it('logs oversize and binary skips without failing discovery', async () => {
    const root = makeTempDir();
    writeText(join(root, 'good.txt'), 'remember me');
    writeText(join(root, 'large.md'), 'x'.repeat(200));
    writeFileSync(join(root, 'binary.txt'), Buffer.from([0, 1, 2, 3]));
    const skipped: LocalDirSkip[] = [];

    const files = await localDirSource.discover({
      paths: [root],
      include: ['**/*'],
      maxFileBytes: 100,
      onSkip: (event) => skipped.push(event),
    });

    expect(files.map((file) => file.relativePath)).toEqual(['good.txt']);
    expect(skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: join(root, 'large.md'), reason: 'too_large' }),
      expect.objectContaining({ path: join(root, 'binary.txt'), reason: 'binary' }),
    ]));
  });

  it('uses a stable source identifier while changing the hash after an edit', async () => {
    const root = makeTempDir();
    const path = join(root, 'notes', 'project.md');
    writeText(path, 'Version one');

    const [firstFile] = await localDirSource.discover({ paths: [root] });
    const first = await localDirSource.readDocuments(firstFile, 'document');
    writeText(path, 'Version two');
    const [secondFile] = await localDirSource.discover({ paths: [root] });
    const second = await localDirSource.readDocuments(secondFile, 'document');

    expect(first.documents[0]).toMatchObject({
      title: 'notes/project.md',
      content: 'Version one',
      sourceIdentifier: `local_dir:${resolve(path)}`,
    });
    expect(second.documents[0].sourceIdentifier).toBe(first.documents[0].sourceIdentifier);
    expect(second.documents[0].sourceSha256).not.toBe(first.documents[0].sourceSha256);
  });

  it('does not discover PDF files by default', async () => {
    const root = makeTempDir();
    const path = join(root, 'reference.pdf');
    writeFileSync(path, Buffer.from('%PDF-1.4\nlocal test PDF', 'utf8'));

    expect(await localDirSource.discover({ paths: [root] })).toEqual([]);
  });
});
