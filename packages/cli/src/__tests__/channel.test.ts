import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getConfigFilePath } from '../config.js';
import { resolveAeHome } from '../home.js';
import { assertHistorySyncAllowed } from '../sync/channel-policy.js';
import { defaultChannelApiUrl } from '../channel.js';
import { CursorStore } from '../sync/cursor-store.js';
import { writeRawArchive } from '../sync/raw-archive.js';

const originalEnvironment = { ...process.env };
const tempDirs: string[] = [];

afterEach(() => {
  process.env = { ...originalEnvironment };
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('channel-aware CLI defaults', () => {
  it('keeps stable legacy paths and selects isolated staging defaults', () => {
    delete process.env.AE_HOME;
    delete process.env.ANSWER_ENGINE_API_URL;
    process.env.AE_CHANNEL = 'stable';
    expect(resolveAeHome()).toBe(join(homedir(), '.answer-engine'));
    expect(getConfigFilePath()).toBe(join(homedir(), '.config', 'answer-engine', 'config.yml'));
    expect(defaultChannelApiUrl()).toBe('http://localhost:5050');

    process.env.AE_CHANNEL = 'staging';
    expect(resolveAeHome()).toBe(join(homedir(), '.answer-engine-staging'));
    expect(getConfigFilePath()).toBe(join(homedir(), '.config', 'answer-engine', 'staging.yml'));
    expect(defaultChannelApiUrl()).toBe('http://127.0.0.1:5150');
  });

  it('refuses staging history sync until persisted opt-in and command confirmation coexist', () => {
    process.env.AE_CHANNEL = 'staging';
    expect(() => assertHistorySyncAllowed({ enabled: false }, true)).toThrow(/disabled/i);
    expect(() => assertHistorySyncAllowed({ enabled: true }, false)).toThrow(/confirm/i);
    expect(() => assertHistorySyncAllowed({ enabled: true }, true)).not.toThrow();
  });

  it('does not require an extra confirmation on stable', () => {
    process.env.AE_CHANNEL = 'stable';
    expect(() => assertHistorySyncAllowed(undefined, false)).not.toThrow();
  });

  it('persists a staging archive and sync cursor without changing stable fixtures', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ae-channel-mutation-'));
    tempDirs.push(root);
    const stableHome = join(root, 'stable');
    const stagingHome = join(root, 'staging');
    const source = join(root, 'source.jsonl');
    const stableDatabase = join(stableHome, 'data', 'database.fixture');
    const stableArchive = join(stableHome, 'raw-archive', 'archive.fixture');
    mkdirSync(join(stableHome, 'data'), { recursive: true });
    mkdirSync(join(stableHome, 'raw-archive'), { recursive: true });
    writeFileSync(stableDatabase, 'stable database bytes');
    writeFileSync(stableArchive, 'stable archive bytes');
    writeFileSync(source, '{"type":"fixture"}\n');
    process.env.AE_CHANNEL = 'staging';
    process.env.AE_HOME = stagingHome;

    const archive = await writeRawArchive([source], {
      adapterName: 'channel-isolation-fixture',
      adapterVersion: '1',
      createdAt: '2026-08-15T00:00:00.000Z',
    });
    const cursor = new CursorStore();
    await cursor.set('codex', source, {
      offset: 1,
      line: 1,
      importedCount: 1,
      skippedCount: 0,
      fileSize: 19,
      lastMtimeMs: 1,
    });
    await cursor.save();

    expect(archive.archiveDir.startsWith(join(stagingHome, 'raw-archive'))).toBe(true);
    expect(cursor.path).toBe(join(stagingHome, 'data', 'sync-cursors.json'));
    expect(readFileSync(stableDatabase, 'utf8')).toBe('stable database bytes');
    expect(readFileSync(stableArchive, 'utf8')).toBe('stable archive bytes');
  });
});
