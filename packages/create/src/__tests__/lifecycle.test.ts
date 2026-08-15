import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runLifecycleAction } from '../lifecycle.js';
import { createRuntimeChannelProfile } from '../runtime-channel.js';

const tempDirs: string[] = [];

function fixture(channel: 'stable' | 'staging' = 'staging') {
  const home = mkdtempSync(join(tmpdir(), 'ae-lifecycle-'));
  tempDirs.push(home);
  const profile = createRuntimeChannelProfile(channel, { home });
  writeFileSync(join(home, 'docker-compose.yml'), 'services: {}\n');
  writeFileSync(join(home, '.env.compose'), `COMPOSE_PROJECT_NAME=${profile.composeProject}\nANSWER_ENGINE_IMAGE=example/current:1\n`);
  writeFileSync(profile.markerFile, `${JSON.stringify({
    schemaVersion: 1,
    channel: profile.channel,
    home: profile.home,
    composeProject: profile.composeProject,
    ports: profile.ports,
    volumes: profile.volumes,
    databaseName: profile.databaseName,
  })}\n`);
  return profile;
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('channel lifecycle actions', () => {
  it.each(['stop', 'repair', 'upgrade', 'rollback', 'uninstall'] as const)(
    'refuses %s when the ownership marker does not match',
    async (action) => {
      const profile = fixture();
      writeFileSync(profile.markerFile, JSON.stringify({ channel: 'stable' }));
      await expect(runLifecycleAction(action, profile, {}, { runCommand: vi.fn() }))
        .rejects.toThrow(/ownership marker/i);
    },
  );

  it('routes start and stop through only the selected Compose project', async () => {
    const profile = fixture();
    const runCommand = vi.fn(async (_command: string, _args: string[]) => ({ stdout: '' }));
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: 'healthy', channel: 'staging', uptime: 1 }), { status: 200 }));

    await runLifecycleAction('start', profile, {}, { runCommand, fetchImpl, probePort: async () => true });
    await runLifecycleAction('stop', profile, {}, { runCommand, fetchImpl });

    for (const [, args] of runCommand.mock.calls) {
      expect(args).toContain(profile.home);
      expect(args).toContain(join(profile.home, '.env.compose'));
      expect(args).not.toContain('answer-engine-local');
    }
  });

  it('reports the selected channel and rejects a health response from another channel', async () => {
    const profile = fixture();
    const runCommand = vi.fn(async (_command: string, _args: string[]) => ({ stdout: 'api\npostgres\nredis\n' }));
    const stableHealth = vi.fn(async () => new Response(JSON.stringify({ status: 'healthy', channel: 'stable', uptime: 1 }), { status: 200 }));
    await expect(runLifecycleAction('status', profile, {}, { runCommand, fetchImpl: stableHealth }))
      .rejects.toThrow(/reported channel stable/i);

    const stagingHealth = vi.fn(async () => new Response(JSON.stringify({ status: 'healthy', channel: 'staging', uptime: 1 }), { status: 200 }));
    const status = await runLifecycleAction('status', profile, {}, { runCommand, fetchImpl: stagingHealth });
    expect(status).toMatchObject({ channel: 'staging', composeProject: 'answer-engine-staging', healthy: true });
  });

  it('refuses startup when any selected port is occupied outside the project', async () => {
    const profile = fixture();
    const runCommand = vi.fn(async (_command: string, _args: string[]) => ({ stdout: '' }));
    await expect(runLifecycleAction('start', profile, {}, {
      runCommand,
      probePort: async (port) => port !== profile.ports.mcp,
    })).rejects.toThrow(`port ${profile.ports.mcp} is occupied`);
    expect(runCommand.mock.calls.some(([, args]) => args.includes('up'))).toBe(false);
  });

  it('tracks current and previous releases for guarded upgrade and rollback', async () => {
    const profile = fixture();
    const runCommand = vi.fn(async (_command: string, _args: string[]) => ({ stdout: '' }));
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: 'healthy', channel: 'staging', uptime: 1 }), { status: 200 }));

    await runLifecycleAction('upgrade', profile, { image: 'example/next:2' }, { runCommand, fetchImpl, probePort: async () => true });
    expect(JSON.parse(readFileSync(profile.releaseFile, 'utf8'))).toEqual({ current: 'example/next:2', previous: 'example/current:1' });
    await runLifecycleAction('rollback', profile, {}, { runCommand, fetchImpl, probePort: async () => true });
    expect(JSON.parse(readFileSync(profile.releaseFile, 'utf8'))).toEqual({ current: 'example/current:1', previous: 'example/next:2' });
  });
});
