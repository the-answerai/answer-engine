import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { uninstall } from '../uninstall.js';
import type { CommandRunner } from '../process.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('uninstall', () => {
  it('stops containers but preserves the installation and data by default', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ae-uninstall-'));
    tempDirs.push(home);
    writeFileSync(join(home, 'docker-compose.yml'), 'services: {}\n');
    const calls: string[][] = [];
    const runCommand: CommandRunner = (_command, args) => {
      calls.push(args);
      return Promise.resolve({ stdout: '' });
    };

    await uninstall({ home, purge: false }, { runCommand });

    expect(calls[0]).toEqual(expect.arrayContaining(['down']));
    expect(calls[0]).not.toContain('--volumes');
    expect(existsSync(home)).toBe(true);
  });

  it('removes Compose volumes and the explicit home only with --purge', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ae-uninstall-purge-'));
    tempDirs.push(home);
    writeFileSync(join(home, 'docker-compose.yml'), 'services: {}\n');
    const calls: string[][] = [];
    const runCommand: CommandRunner = (_command, args) => {
      calls.push(args);
      return Promise.resolve({ stdout: '' });
    };

    await uninstall({ home, purge: true }, { runCommand });

    expect(calls[0]).toContain('--volumes');
    expect(existsSync(home)).toBe(false);
  });

  it('refuses to purge a directory without the installer Compose marker', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ae-uninstall-unsafe-'));
    tempDirs.push(home);

    await expect(uninstall({ home, purge: true })).rejects.toThrow(
      'installer-managed docker-compose.yml was not found',
    );
    expect(existsSync(home)).toBe(true);
  });

  it('treats purging an already removed home as an idempotent no-op', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'ae-uninstall-missing-'));
    tempDirs.push(parent);
    const home = join(parent, 'already-removed');

    await expect(uninstall({ home, purge: true })).resolves.toBeUndefined();
  });
});
