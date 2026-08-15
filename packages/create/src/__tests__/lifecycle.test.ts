import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runLifecycleAction } from '../lifecycle.js';
import { createRuntimeChannelProfile, writeRuntimeOwnershipMarker } from '../runtime-channel.js';

const tempDirs: string[] = [];

function fixture(channel: 'stable' | 'staging' = 'staging') {
  const home = mkdtempSync(join(tmpdir(), 'ae-lifecycle-'));
  tempDirs.push(home);
  const profile = createRuntimeChannelProfile(channel, { home });
  writeFileSync(join(home, 'docker-compose.yml'), 'services: {}\n');
  writeFileSync(join(home, '.env.compose'), [
    `COMPOSE_PROJECT_NAME=${profile.composeProject}`,
    `AE_CHANNEL=${profile.channel}`,
    `AE_HISTORY_SYNC_ENABLED=${profile.sync.enabledByDefault}`,
    `ANSWER_ENGINE_SYNC_ENABLED=${profile.sync.enabledByDefault}`,
    `ANSWER_ENGINE_PORT=${profile.ports.api}`,
    `DATABASE_PORT_HOST=${profile.ports.database}`,
    `REDIS_PORT_HOST=${profile.ports.redis}`,
    `WEB_UI_PORT=${profile.ports.web}`,
    `ANSWER_ENGINE_MCP_PORT=${profile.ports.mcp}`,
    `DATABASE_NAME=${profile.databaseName}`,
    'ANSWER_ENGINE_IMAGE=example/current:1',
    '',
  ].join('\n'));
  writeRuntimeOwnershipMarker(profile);
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

  it.each(['start', 'stop', 'status', 'repair', 'upgrade', 'rollback', 'uninstall'] as const)(
    'refuses %s before Docker when the selected environment drifts to the stable project',
    async (action) => {
      const profile = fixture();
      const environment = readFileSync(profile.credentialsFile, 'utf8')
        .replace(`COMPOSE_PROJECT_NAME=${profile.composeProject}`, 'COMPOSE_PROJECT_NAME=answer-engine-local');
      writeFileSync(profile.credentialsFile, environment);
      const runCommand = vi.fn(async () => ({ stdout: '' }));

      await expect(runLifecycleAction(action, profile, {}, { runCommand }))
        .rejects.toThrow(/compose project.*expected answer-engine-staging/i);
      expect(runCommand).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['AE_CHANNEL', 'stable'],
    ['AE_HISTORY_SYNC_ENABLED', 'true'],
    ['ANSWER_ENGINE_SYNC_ENABLED', 'true'],
    ['ANSWER_ENGINE_PORT', '5050'],
    ['DATABASE_PORT_HOST', '5433'],
    ['REDIS_PORT_HOST', '6380'],
    ['WEB_UI_PORT', '3200'],
    ['ANSWER_ENGINE_MCP_PORT', '5051'],
    ['DATABASE_NAME', 'answerengine'],
  ])('refuses resource drift in %s', async (key, replacement) => {
    const profile = fixture();
    const environment = readFileSync(profile.credentialsFile, 'utf8')
      .replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${replacement}`);
    writeFileSync(profile.credentialsFile, environment);
    const runCommand = vi.fn(async () => ({ stdout: '' }));

    await expect(runLifecycleAction('status', profile, {}, { runCommand }))
      .rejects.toThrow(new RegExp(`Runtime (channel|${key})`, 'i'));
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('refuses a changed Compose definition before Docker runs', async () => {
    const profile = fixture();
    writeFileSync(join(profile.home, 'docker-compose.yml'), 'services:\n  api: {}\n');
    const runCommand = vi.fn(async () => ({ stdout: '' }));

    await expect(runLifecycleAction('stop', profile, {}, { runCommand }))
      .rejects.toThrow(/ownership marker/i);
    expect(runCommand).not.toHaveBeenCalled();
  });

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
