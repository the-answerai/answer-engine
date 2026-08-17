import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRuntimeChannelProfile,
  validateRuntimeChannelIsolation,
  writeRuntimeOwnershipMarker,
  type RuntimeChannelProfile,
} from '../runtime-channel.js';

const tempDirs: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ae-channel-'));
  tempDirs.push(root);
  return root;
}

function profiles(root: string): [RuntimeChannelProfile, RuntimeChannelProfile] {
  return [
    createRuntimeChannelProfile('stable', { home: join(root, 'stable') }),
    createRuntimeChannelProfile('staging', { home: join(root, 'staging') }),
  ];
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('runtime channel profiles', () => {
  it('preserves stable compatibility while assigning staging a disjoint identity', () => {
    const root = tempRoot();
    const [stable, staging] = profiles(root);

    expect(stable).toMatchObject({
      channel: 'stable',
      composeProject: 'answer-engine-local',
      databaseName: 'answerengine',
      apiUrl: 'http://localhost:5050',
      ports: { api: 5050, database: 5433, redis: 6380, web: 3200, mcp: 5051 },
      sync: { enabledByDefault: true, launchdLabel: 'ai.answer-engine.sync', systemdUnit: 'answer-engine-sync.service' },
    });
    expect(staging).toMatchObject({
      channel: 'staging',
      composeProject: 'answer-engine-staging',
      databaseName: 'answerengine_staging',
      apiUrl: 'http://127.0.0.1:5150',
      ports: { api: 5150, database: 5533, redis: 6480, web: 3300, mcp: 5151 },
      sync: { enabledByDefault: false, launchdLabel: 'ai.answer-engine.staging.sync', systemdUnit: 'answer-engine-staging-sync.service' },
    });
    expect(staging.home).not.toBe(stable.home);
    expect(staging.credentialsFile).not.toBe(stable.credentialsFile);
    expect(Object.values(staging.volumes)).not.toEqual(expect.arrayContaining(Object.values(stable.volumes)));
  });

  it.each([
    ['home overlap', (stable: RuntimeChannelProfile, staging: RuntimeChannelProfile) => ({ ...staging, home: join(stable.home, 'nested'), dataDir: join(stable.home, 'nested', 'data') })],
    ['data overlap', (stable: RuntimeChannelProfile, staging: RuntimeChannelProfile) => ({ ...staging, dataDir: stable.dataDir })],
    ['log overlap', (stable: RuntimeChannelProfile, staging: RuntimeChannelProfile) => ({ ...staging, logsDir: stable.logsDir })],
    ['archive overlap', (stable: RuntimeChannelProfile, staging: RuntimeChannelProfile) => ({ ...staging, rawArchiveDir: stable.rawArchiveDir })],
    ['credential path', (stable: RuntimeChannelProfile, staging: RuntimeChannelProfile) => ({ ...staging, credentialsFile: stable.credentialsFile })],
    ['Compose project', (stable: RuntimeChannelProfile, staging: RuntimeChannelProfile) => ({ ...staging, composeProject: stable.composeProject })],
    ['API port', (stable: RuntimeChannelProfile, staging: RuntimeChannelProfile) => ({ ...staging, ports: { ...staging.ports, api: stable.ports.api } })],
    ['database name', (stable: RuntimeChannelProfile, staging: RuntimeChannelProfile) => ({ ...staging, databaseName: stable.databaseName })],
    ['volume name', (stable: RuntimeChannelProfile, staging: RuntimeChannelProfile) => ({ ...staging, volumes: { ...staging.volumes, redis: stable.volumes.redis } })],
    ['launch service', (stable: RuntimeChannelProfile, staging: RuntimeChannelProfile) => ({ ...staging, sync: { ...staging.sync, launchdLabel: stable.sync.launchdLabel } })],
  ])('rejects a %s collision', async (_name, collide) => {
    const root = tempRoot();
    const [stable, staging] = profiles(root);
    await expect(validateRuntimeChannelIsolation([stable, collide(stable, staging)]))
      .rejects.toThrow(/collision|overlap/i);
  });

  it('canonicalizes symlinks before comparing channel paths', async () => {
    const root = tempRoot();
    const [stable, staging] = profiles(root);
    mkdirSync(stable.home, { recursive: true });
    symlinkSync(stable.home, staging.home);
    await expect(validateRuntimeChannelIsolation([stable, staging])).rejects.toThrow(/overlap/i);
  });

  it('rejects unresolved symbolic-link resources', async () => {
    const root = tempRoot();
    const [stable, staging] = profiles(root);
    symlinkSync(join(root, 'missing-target'), staging.home);
    await expect(validateRuntimeChannelIsolation([stable, staging]))
      .rejects.toThrow(/unresolved symbolic-link runtime path/i);
  });

  it('refuses to overwrite a symbolic-link ownership marker', () => {
    const root = tempRoot();
    const [stable] = profiles(root);
    mkdirSync(stable.home, { recursive: true });
    writeFileSync(join(stable.home, 'docker-compose.yml'), 'services: {}\n');
    const target = join(root, 'unrelated.json');
    writeFileSync(target, 'preserve me\n');
    symlinkSync(target, stable.markerFile);

    expect(() => writeRuntimeOwnershipMarker(stable)).toThrow(/symbolic link/i);
    expect(readFileSync(target, 'utf8')).toBe('preserve me\n');
  });

  it('rejects matching credential fingerprints without exposing their values', async () => {
    const root = tempRoot();
    const [stable, staging] = profiles(root);
    mkdirSync(stable.home, { recursive: true });
    mkdirSync(staging.home, { recursive: true });
    const secret = 'same-secret-must-never-appear-in-errors';
    writeFileSync(stable.credentialsFile, `ENCRYPTION_KEY=${secret}\n`);
    writeFileSync(staging.credentialsFile, `ENCRYPTION_KEY=${secret}\n`);

    let message = '';
    try { await validateRuntimeChannelIsolation([stable, staging]); }
    catch (error) { message = error instanceof Error ? error.message : String(error); }
    expect(message).toMatch(/credential fingerprint collision/i);
    expect(message).not.toContain(secret);
  });

  it('rejects unresolved or empty resource identities', async () => {
    const root = tempRoot();
    const [stable, staging] = profiles(root);
    await expect(validateRuntimeChannelIsolation([stable, { ...staging, composeProject: '  ' }]))
      .rejects.toThrow(/composeProject/i);
  });

  it('rejects resources duplicated inside one channel profile', async () => {
    const root = tempRoot();
    const [stable, staging] = profiles(root);
    await expect(validateRuntimeChannelIsolation([
      stable,
      { ...staging, ports: { ...staging.ports, mcp: staging.ports.api } },
    ])).rejects.toThrow(/port collision inside the staging/i);
  });

  it('keeps a deliberate staging mutation out of stable data and archives', () => {
    const root = tempRoot();
    const [stable, staging] = profiles(root);
    mkdirSync(stable.dataDir, { recursive: true });
    mkdirSync(stable.rawArchiveDir, { recursive: true });
    mkdirSync(staging.dataDir, { recursive: true });
    mkdirSync(staging.rawArchiveDir, { recursive: true });
    const stableDatabase = join(stable.dataDir, 'fixture.db');
    const stableArchive = join(stable.rawArchiveDir, 'history.jsonl');
    writeFileSync(stableDatabase, 'stable-database-bytes');
    writeFileSync(stableArchive, 'stable-archive-bytes');

    writeFileSync(join(staging.dataDir, 'fixture.db'), 'staging mutation');
    writeFileSync(join(staging.rawArchiveDir, 'history.jsonl'), 'staging mutation');

    expect(readFileSync(stableDatabase, 'utf8')).toBe('stable-database-bytes');
    expect(readFileSync(stableArchive, 'utf8')).toBe('stable-archive-bytes');
  });
});
