import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  blobsDir,
  configYamlPath,
  ensureAeHomeLayout,
  envFilePath,
  evalResultsDir,
  evalSetPath,
  evalSetsDir,
  logsDir,
  postgresDataDir,
  rawArchiveDir,
  redisDataDir,
  resolveAeHome,
  syncStderrLogPath,
  syncStdoutLogPath,
} from '../home.js';

const originalAeHome = process.env.AE_HOME;
const tempDirs: string[] = [];

afterEach(() => {
  if (originalAeHome === undefined) delete process.env.AE_HOME;
  else process.env.AE_HOME = originalAeHome;

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Answer Engine home layout', () => {
  it('defaults to ~/.answer-engine', () => {
    delete process.env.AE_HOME;

    expect(resolveAeHome()).toBe(join(homedir(), '.answer-engine'));
  });

  it('resolves every path beneath the AE_HOME override', () => {
    const home = mkdtempSync(join(tmpdir(), 'ae-home-'));
    tempDirs.push(home);
    process.env.AE_HOME = home;

    expect(resolveAeHome()).toBe(home);
    expect(configYamlPath()).toBe(join(home, 'config.yaml'));
    expect(envFilePath()).toBe(join(home, '.env'));
    expect(postgresDataDir()).toBe(join(home, 'data', 'postgres'));
    expect(redisDataDir()).toBe(join(home, 'data', 'redis'));
    expect(blobsDir()).toBe(join(home, 'blobs'));
    expect(rawArchiveDir()).toBe(join(home, 'raw-archive'));
    expect(logsDir()).toBe(join(home, 'logs'));
    expect(evalSetsDir()).toBe(join(home, 'eval', 'sets'));
    expect(evalSetPath('golden')).toBe(join(home, 'eval', 'sets', 'golden.jsonl'));
    expect(evalResultsDir()).toBe(join(home, 'eval', 'results'));
    expect(syncStdoutLogPath()).toBe(join(home, 'logs', 'sync.out.log'));
    expect(syncStderrLogPath()).toBe(join(home, 'logs', 'sync.err.log'));
  });

  it('creates all persistent directories recursively', () => {
    const parent = mkdtempSync(join(tmpdir(), 'ae-layout-'));
    tempDirs.push(parent);
    process.env.AE_HOME = join(parent, 'nested', 'answer-engine');

    ensureAeHomeLayout();

    expect(existsSync(postgresDataDir())).toBe(true);
    expect(existsSync(redisDataDir())).toBe(true);
    expect(existsSync(blobsDir())).toBe(true);
    expect(existsSync(rawArchiveDir())).toBe(true);
    expect(existsSync(logsDir())).toBe(true);
    expect(existsSync(evalSetsDir())).toBe(true);
    expect(existsSync(evalResultsDir())).toBe(true);
  });
});
