import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activateApiKey, extractApiKey, persistApiKey } from '../docker.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Docker bootstrap key handling', () => {
  it('extracts only the minted Answer Engine API key from init logs', () => {
    expect(extractApiKey('init | ready\ninit | ANSWER_ENGINE_API_KEY=ae_live_secret\n'))
      .toBe('ae_live_secret');
    expect(extractApiKey('init | already initialized\n')).toBeUndefined();
  });

  it('persists the key exactly once with owner-only permissions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ae-key-'));
    tempDirs.push(dir);
    const path = join(dir, '.env.compose');
    writeFileSync(path, 'AUTH_MODE=api_key\n', { mode: 0o600 });

    persistApiKey(path, 'ae_live_secret');
    persistApiKey(path, 'ae_live_secret');

    expect(readFileSync(path, 'utf8').match(/^ANSWER_ENGINE_API_KEY=/gm)).toHaveLength(1);
  });

  it('recreates the API after persisting a first-run key', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ae-key-'));
    tempDirs.push(home);
    const envPath = join(home, '.env.compose');
    writeFileSync(envPath, 'LOCAL_UI_AUTO_AUTH=true\n', { mode: 0o600 });
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      expect(readFileSync(envPath, 'utf8')).toContain('ANSWER_ENGINE_API_KEY=ae_live_first_run');
      expect(args.slice(-4)).toEqual(['up', '-d', '--force-recreate', 'api']);
      return { stdout: '' };
    });
    const fetchImpl = vi.fn(async () => ({ ok: true } as Response));

    await activateApiKey(home, envPath, 'ae_live_first_run', { runCommand, fetchImpl });

    expect(runCommand).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith('http://localhost:5050/health');
  });
});
