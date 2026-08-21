import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runLifecycleAction } from '../lifecycle.js';
import { createRuntimeChannelProfile, writeRuntimeOwnershipMarker } from '../runtime-channel.js';
import { releaseFixture, TEST_SOURCE_COMMIT } from './release-fixture.js';

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
    `ANSWER_ENGINE_IMAGE=example/current@sha256:${'1'.repeat(64)}`,
    '',
  ].join('\n'));
  writeRuntimeOwnershipMarker(profile);
  return profile;
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('channel lifecycle actions', () => {
  const release = releaseFixture();
  it('refuses start before Docker when the ownership marker is missing', async () => {
    const profile = fixture('stable');
    rmSync(profile.markerFile);
    const runCommand = vi.fn();

    await expect(runLifecycleAction('start', profile, {}, { runCommand }))
      .rejects.toThrow(/ownership marker is missing/i);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it.each(['stop', 'repair', 'upgrade', 'rollback', 'uninstall'] as const)(
    'refuses %s when the ownership marker does not match',
    async (action) => {
      const profile = fixture();
      writeFileSync(profile.markerFile, JSON.stringify({ channel: 'stable' }));
      await expect(runLifecycleAction(action, profile, {}, { runCommand: vi.fn(), release }))
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

      await expect(runLifecycleAction(action, profile, {}, { runCommand, release }))
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
    const runCommand = vi.fn(async (_command: string, _args: string[]) => ({ stdout: '' }));

    await expect(runLifecycleAction('status', profile, {}, { runCommand }))
      .rejects.toThrow(new RegExp(`Runtime (channel|${key})`, 'i'));
    expect(runCommand).not.toHaveBeenCalled();
  });

  it.each([
    'ghcr.io/the-answerai/answer-engine:latest',
    `example/other@sha256:${'9'.repeat(64)}`,
  ])('refuses managed runtime image drift in %s before Docker runs', async (image) => {
    const profile = fixture();
    const current = `example/current@sha256:${'1'.repeat(64)}`;
    writeFileSync(profile.releaseFile, `${JSON.stringify({
      schemaVersion: 1,
      sourceCommit: TEST_SOURCE_COMMIT,
      current,
      previous: current,
      verifiedAtInstall: true,
    })}\n`);
    const environment = readFileSync(profile.credentialsFile, 'utf8')
      .replace(/^ANSWER_ENGINE_IMAGE=.*$/m, `ANSWER_ENGINE_IMAGE=${image}`);
    writeFileSync(profile.credentialsFile, environment);
    const runCommand = vi.fn(async () => ({ stdout: '' }));

    await expect(runLifecycleAction('stop', profile, {}, { runCommand }))
      .rejects.toThrow(/runtime image.*release state/i);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('refuses a changed Compose definition before Docker runs', async () => {
    const profile = fixture();
    writeFileSync(join(profile.home, 'docker-compose.yml'), 'services:\n  api: {}\n');
    const runCommand = vi.fn(async (_command: string, _args: string[]) => ({ stdout: '' }));

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

    const current = `example/current@sha256:${'1'.repeat(64)}`;
    const next = `example/next@sha256:${'2'.repeat(64)}`;
    await runLifecycleAction('upgrade', profile, { image: next }, {
      runCommand, fetchImpl, probePort: async () => true, release,
    });
    expect(JSON.parse(readFileSync(profile.releaseFile, 'utf8'))).toEqual({
      schemaVersion: 1,
      sourceCommit: TEST_SOURCE_COMMIT,
      current: next, previous: current, verifiedAtInstall: false, lastAction: 'upgrade',
    });
    await runLifecycleAction('rollback', profile, {}, {
      runCommand, fetchImpl, probePort: async () => true, release,
    });
    expect(JSON.parse(readFileSync(profile.releaseFile, 'utf8'))).toEqual({
      schemaVersion: 1,
      sourceCommit: TEST_SOURCE_COMMIT,
      current, previous: next, verifiedAtInstall: false, lastAction: 'rollback',
    });

    const callsAfterRollback = runCommand.mock.calls.length;
    await runLifecycleAction('rollback', profile, {}, {
      runCommand, fetchImpl, probePort: async () => true, release,
    });
    expect(runCommand).toHaveBeenCalledTimes(callsAfterRollback);
  });

  it.each([
    'ghcr.io/the-answerai/answer-engine:1.1.2',
    'ghcr.io/the-answerai/answer-engine:latest',
    'ghcr.io/the-answerai/answer-engine@sha256:not-a-digest',
  ])('rejects mutable or malformed upgrade image %s before Docker or file mutation', async (image) => {
    const profile = fixture();
    const beforeEnvironment = readFileSync(profile.credentialsFile, 'utf8');
    const runCommand = vi.fn(async () => ({ stdout: '' }));

    await expect(runLifecycleAction('upgrade', profile, { image }, { runCommand, release }))
      .rejects.toThrow(/exact @sha256 digest/i);
    expect(runCommand).not.toHaveBeenCalled();
    expect(readFileSync(profile.credentialsFile, 'utf8')).toBe(beforeEnvironment);
    expect(existsSync(profile.releaseFile)).toBe(false);
  });

  it('repairs a healthy runtime as an explicit no-op', async () => {
    const profile = fixture();
    const runCommand = vi.fn(async (_command: string, _args: string[]) => ({ stdout: 'api\npostgres\nredis\n' }));
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      status: 'healthy', channel: 'staging', uptime: 1,
    }), { status: 200 }));

    await runLifecycleAction('repair', profile, {}, { runCommand, fetchImpl, probePort: async () => true });

    expect(runCommand.mock.calls.some(([, args]) => args.includes('up'))).toBe(false);
  });

  it('moves a readable legacy tag to a digest without recording the tag for rollback', async () => {
    const profile = fixture('stable');
    const environment = readFileSync(profile.credentialsFile, 'utf8')
      .replace(/ANSWER_ENGINE_IMAGE=.*/, 'ANSWER_ENGINE_IMAGE=ghcr.io/the-answerai/answer-engine:1.1.2');
    writeFileSync(profile.credentialsFile, environment);
    const next = `ghcr.io/the-answerai/answer-engine@sha256:${'3'.repeat(64)}`;
    const runCommand = vi.fn(async () => ({ stdout: '' }));
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      status: 'healthy', channel: 'stable', uptime: 1,
    }), { status: 200 }));

    await runLifecycleAction('upgrade', profile, { image: next }, {
      runCommand, fetchImpl, probePort: async () => true, release,
    });

    expect(readFileSync(profile.credentialsFile, 'utf8')).toContain(`ANSWER_ENGINE_IMAGE=${next}`);
    expect(JSON.parse(readFileSync(profile.releaseFile, 'utf8'))).toMatchObject({
      current: next, previous: next,
    });
  });

  it('resumes a failed upgrade without losing the prior rollback target', async () => {
    const profile = fixture();
    const current = `example/current@sha256:${'1'.repeat(64)}`;
    const next = `example/next@sha256:${'2'.repeat(64)}`;
    let failRecreate = true;
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes('up') && failRecreate) {
        failRecreate = false;
        throw new Error('simulated interrupted recreate');
      }
      return { stdout: '' };
    });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      status: 'healthy', channel: 'staging', uptime: 1,
    }), { status: 200 }));

    await expect(runLifecycleAction('upgrade', profile, { image: next }, {
      runCommand, fetchImpl, probePort: async () => true, release,
    })).rejects.toThrow('simulated interrupted recreate');
    expect(JSON.parse(readFileSync(profile.releaseFile, 'utf8'))).toMatchObject({
      pending: { action: 'upgrade', from: current, to: next },
    });

    await runLifecycleAction('upgrade', profile, { image: next }, {
      runCommand, fetchImpl, probePort: async () => true, release,
    });
    expect(JSON.parse(readFileSync(profile.releaseFile, 'utf8'))).toEqual({
      schemaVersion: 1,
      sourceCommit: TEST_SOURCE_COMMIT,
      current: next, previous: current, verifiedAtInstall: false, lastAction: 'upgrade',
    });
  });

  it('refuses to overwrite a symbolic-link release state during upgrade', async () => {
    const profile = fixture();
    const target = join(profile.home, 'unrelated.json');
    writeFileSync(target, 'preserve me\n');
    symlinkSync(target, profile.releaseFile);
    const runCommand = vi.fn(async (_command: string, _args: string[]) => ({ stdout: '' }));

    await expect(runLifecycleAction('upgrade', profile, {
      image: `example/next@sha256:${'2'.repeat(64)}`,
    }, { runCommand, probePort: async () => true, release })).rejects.toThrow(/release state.*symbolic link/i);
    expect(readFileSync(target, 'utf8')).toBe('preserve me\n');
    expect(runCommand.mock.calls.some(([, args]) => args.includes('pull'))).toBe(false);
  });
});
