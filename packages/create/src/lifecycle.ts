import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { detectOwnedPorts, dockerComposeArgs } from './docker.js';
import { isPortFree } from './preflight.js';
import type { CommandRunner } from './process.js';
import { runCommand as defaultRunCommand } from './process.js';
import { readEnvValue } from './scaffold.js';
import { uninstall } from './uninstall.js';
import { assertRuntimeChannelConfiguration, type RuntimeChannelProfile } from './runtime-channel.js';
import {
  assertImmutableImageReference,
  DigestReferenceSchema,
  verifyBundledRelease,
  type ReleaseManifest,
} from './release.js';
import { ReleaseStateSchema, type ReleaseState } from './release-state.js';
import { assertRegularFileTarget, writePrivateFileAtomic } from './safe-file.js';

export const LifecycleActionSchema = z.enum([
  'preflight', 'install', 'start', 'stop', 'status', 'repair', 'upgrade', 'rollback', 'uninstall',
]);
export type LifecycleAction = z.infer<typeof LifecycleActionSchema>;

const OwnershipMarkerSchema = z.object({
  schemaVersion: z.literal(2),
  channel: z.enum(['stable', 'staging']),
  home: z.string().min(1),
  composeProject: z.string().min(1),
  ports: z.record(z.number().int()),
  volumes: z.record(z.string().min(1)),
  databaseName: z.string().min(1),
  composeFileSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export interface LifecycleOptions {
  purge?: boolean;
  image?: string;
}

export interface LifecycleDependencies {
  runCommand?: CommandRunner;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  healthAttempts?: number;
  probePort?: (port: number) => Promise<boolean>;
  release?: ReleaseManifest;
}

async function assertSelectedPortsAvailable(
  profile: RuntimeChannelProfile,
  command: CommandRunner,
  dependencies: LifecycleDependencies,
): Promise<void> {
  const ownedPorts = await detectOwnedPorts(profile.home, { runCommand: command }, profile);
  const probePort = dependencies.probePort ?? isPortFree;
  for (const port of Object.values(profile.ports)) {
    if (ownedPorts.has(port) || await probePort(port)) continue;
    throw new Error(`Refusing ${profile.channel} startup: port ${port} is occupied by another runtime.`);
  }
}

export interface LifecycleStatus {
  channel: 'stable' | 'staging';
  home: string;
  composeProject: string;
  apiUrl: string;
  ports: RuntimeChannelProfile['ports'];
  installed: boolean;
  healthy: boolean;
  runningServices: string[];
  release?: string;
  syncService: {
    launchdLabel: string;
    systemdUnit: string;
    enabledByDefault: boolean;
    historyAccessEnabled: boolean;
    installed: boolean;
  };
}

function syncServiceStatus(profile: RuntimeChannelProfile): LifecycleStatus['syncService'] {
  const unitPath = process.platform === 'darwin'
    ? join(homedir(), 'Library', 'LaunchAgents', `${profile.sync.launchdLabel}.plist`)
    : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user', profile.sync.systemdUnit);
  const environment = existsSync(profile.credentialsFile) ? readFileSync(profile.credentialsFile, 'utf8') : '';
  return {
    ...profile.sync,
    historyAccessEnabled: readEnvValue(environment, 'AE_HISTORY_SYNC_ENABLED') === 'true',
    installed: existsSync(unitPath),
  };
}

function currentRelease(profile: RuntimeChannelProfile): string | undefined {
  if (existsSync(profile.releaseFile)) {
    try {
      const parsed = ReleaseStateSchema.safeParse(JSON.parse(readFileSync(profile.releaseFile, 'utf8')));
      if (parsed.success) return parsed.data.current;
    } catch {
      // Fall through to the pinned Compose environment when release history is malformed.
    }
  }
  const environment = existsSync(profile.credentialsFile) ? readFileSync(profile.credentialsFile, 'utf8') : '';
  const image = readEnvValue(environment, 'ANSWER_ENGINE_IMAGE');
  return image && DigestReferenceSchema.safeParse(image).success ? image : undefined;
}

export function parseLifecycleAction(value: string | undefined): LifecycleAction {
  const result = LifecycleActionSchema.safeParse(value ?? 'install');
  if (!result.success) throw new Error(`Unknown action "${value}"; choose ${LifecycleActionSchema.options.join(', ')}.`);
  return result.data;
}

export function assertRuntimeOwnership(profile: RuntimeChannelProfile): void {
  try {
    if (lstatSync(profile.markerFile).isSymbolicLink()) throw new Error('marker is a symbolic link');
    const marker = OwnershipMarkerSchema.parse(JSON.parse(readFileSync(profile.markerFile, 'utf8')));
    const composeFileSha256 = createHash('sha256')
      .update(readFileSync(join(profile.home, 'docker-compose.yml')))
      .digest('hex');
    const matches = marker.channel === profile.channel
      && marker.home === profile.home
      && marker.composeProject === profile.composeProject
      && marker.databaseName === profile.databaseName
      && JSON.stringify(marker.ports) === JSON.stringify(profile.ports)
      && JSON.stringify(marker.volumes) === JSON.stringify(profile.volumes)
      && marker.composeFileSha256 === composeFileSha256;
    if (!matches) throw new Error('marker does not match the selected channel');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Refusing lifecycle action: runtime ownership marker is missing or invalid (${reason}).`);
  }
  assertRuntimeChannelConfiguration(profile);
}

async function readChannelHealth(
  profile: RuntimeChannelProfile,
  dependencies: LifecycleDependencies,
): Promise<{ healthy: boolean; channel?: string }> {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const attempts = dependencies.healthAttempts ?? 180;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImpl(`${profile.apiUrl}/health`);
      if (response.ok) {
        const payload = await response.json() as { status?: unknown; channel?: unknown };
        const reportedChannel = typeof payload.channel === 'string' ? payload.channel : undefined;
        if (reportedChannel !== profile.channel) {
          throw new Error(`Health endpoint reported channel ${reportedChannel ?? '(missing)'}, expected ${profile.channel}.`);
        }
        return { healthy: payload.status === 'healthy', channel: reportedChannel };
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Health endpoint reported channel')) throw error;
    }
    if (attempt + 1 < attempts) await sleep(1_000);
  }
  return { healthy: false };
}

function replaceEnvAssignment(path: string, key: string, value: string): void {
  if (!/^\S+$/.test(value)) throw new Error(`${key} must not contain whitespace.`);
  const existing = readFileSync(path, 'utf8').split(/\r?\n/);
  const assignment = `${key}=${value}`;
  let found = false;
  const output = existing.filter((line) => line !== '').map((line) => {
    if (!new RegExp(`^\\s*${key}\\s*=`).test(line)) return line;
    if (found) return '';
    found = true;
    return assignment;
  }).filter(Boolean);
  if (!found) output.push(assignment);
  writeFileSync(path, `${output.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
}

function writeReleaseState(path: string, state: ReleaseState): void {
  writePrivateFileAtomic(
    path,
    `${JSON.stringify(ReleaseStateSchema.parse(state))}\n`,
    'Release state',
  );
}

async function recreate(
  profile: RuntimeChannelProfile,
  command: CommandRunner,
  dependencies: LifecycleDependencies,
  pull: boolean,
): Promise<void> {
  if (pull) await command('docker', dockerComposeArgs(profile.home, ['pull']));
  await command('docker', dockerComposeArgs(profile.home, ['up', '-d', '--remove-orphans', '--force-recreate']));
  const health = await readChannelHealth(profile, dependencies);
  if (!health.healthy) throw new Error(`${profile.channel} Answer Engine did not become healthy at ${profile.apiUrl}.`);
}

export async function runLifecycleAction(
  action: Exclude<LifecycleAction, 'install' | 'preflight'>,
  profile: RuntimeChannelProfile,
  options: LifecycleOptions = {},
  dependencies: LifecycleDependencies = {},
): Promise<LifecycleStatus | void> {
  const command = dependencies.runCommand ?? defaultRunCommand;
  const manifest = action === 'upgrade' || action === 'rollback'
    ? dependencies.release ?? verifyBundledRelease()
    : undefined;
  const requestedImage = action === 'upgrade'
    ? assertImmutableImageReference(options.image ?? manifest!.images.answerEngine)
    : undefined;
  if (action === 'status' && !existsSync(profile.markerFile)) {
    return {
      channel: profile.channel, home: profile.home, composeProject: profile.composeProject,
      apiUrl: profile.apiUrl, ports: profile.ports, installed: false, healthy: false,
      runningServices: [], syncService: syncServiceStatus(profile),
    };
  }
  assertRuntimeOwnership(profile);

  if (action === 'rollback' && existsSync(profile.releaseFile)) {
    try {
      const releaseState = ReleaseStateSchema.parse(JSON.parse(readFileSync(profile.releaseFile, 'utf8')));
      if (releaseState.lastAction === 'rollback' && !releaseState.pending) return;
    } catch {
      // The guarded rollback branch below reports the actionable error.
    }
  }

  if (action === 'start' || action === 'repair' || action === 'upgrade' || action === 'rollback') {
    await assertSelectedPortsAvailable(profile, command, dependencies);
  }

  if (action === 'stop') {
    await command('docker', dockerComposeArgs(profile.home, ['down', '--remove-orphans']));
    return;
  }
  if (action === 'uninstall') {
    await uninstall({ home: profile.home, purge: options.purge ?? false }, { runCommand: command });
    return;
  }
  if (action === 'start') {
    await recreate(profile, command, dependencies, false);
    return;
  }
  if (action === 'repair') {
    const health = await readChannelHealth(profile, { ...dependencies, healthAttempts: 1 });
    if (health.healthy) return;
    await recreate(profile, command, dependencies, false);
    return;
  }
  if (action === 'upgrade') {
    assertRegularFileTarget(profile.releaseFile, 'Release state');
    const environment = readFileSync(profile.credentialsFile, 'utf8');
    const configuredCurrent = readEnvValue(environment, 'ANSWER_ENGINE_IMAGE');
    const configuredIsImmutable = Boolean(configuredCurrent && DigestReferenceSchema.safeParse(configuredCurrent).success);
    const current = configuredIsImmutable ? configuredCurrent! : requestedImage!;
    const next = requestedImage!;
    let pendingFrom = current;
    if (existsSync(profile.releaseFile)) {
      try {
        const state = ReleaseStateSchema.parse(JSON.parse(readFileSync(profile.releaseFile, 'utf8')));
        if (state.pending?.action === 'upgrade' && state.pending.to === next) pendingFrom = state.pending.from;
      } catch {
        // A fresh guarded upgrade replaces malformed non-secret release history.
      }
    }
    if (next === current && configuredIsImmutable) {
      const health = await readChannelHealth(profile, { ...dependencies, healthAttempts: 1 });
      if (health.healthy && pendingFrom === current) return;
    } else {
      replaceEnvAssignment(profile.credentialsFile, 'ANSWER_ENGINE_IMAGE', next);
    }
    writeReleaseState(profile.releaseFile, {
      schemaVersion: 1, sourceCommit: manifest!.sourceCommit, verifiedAtInstall: false,
      current: pendingFrom, previous: pendingFrom,
      pending: { action: 'upgrade', from: pendingFrom, to: next },
    });
    await recreate(profile, command, dependencies, true);
    writeReleaseState(profile.releaseFile, {
      schemaVersion: 1, sourceCommit: manifest!.sourceCommit, verifiedAtInstall: false,
      current: next, previous: pendingFrom, lastAction: 'upgrade',
    });
    return;
  }
  if (action === 'rollback') {
    assertRegularFileTarget(profile.releaseFile, 'Release state');
    let release;
    try { release = ReleaseStateSchema.parse(JSON.parse(readFileSync(profile.releaseFile, 'utf8'))); }
    catch { throw new Error(`No guarded rollback release is recorded for ${profile.channel}.`); }
    if (release.lastAction === 'rollback' && !release.pending) return;
    const from = release.pending?.action === 'rollback' ? release.pending.from : release.current;
    const to = release.pending?.action === 'rollback' ? release.pending.to : release.previous;
    assertImmutableImageReference(to);
    replaceEnvAssignment(profile.credentialsFile, 'ANSWER_ENGINE_IMAGE', to);
    writeReleaseState(profile.releaseFile, {
      schemaVersion: 1, sourceCommit: release.sourceCommit, verifiedAtInstall: release.verifiedAtInstall,
      current: from, previous: to, pending: { action: 'rollback', from, to },
    });
    await recreate(profile, command, dependencies, true);
    writeReleaseState(profile.releaseFile, {
      schemaVersion: 1, sourceCommit: release.sourceCommit, verifiedAtInstall: release.verifiedAtInstall,
      current: to, previous: from, lastAction: 'rollback',
    });
    return;
  }

  const result = await command('docker', dockerComposeArgs(profile.home, ['ps', '--services', '--status', 'running']));
  const health = await readChannelHealth(profile, { ...dependencies, healthAttempts: 1 });
  return {
    channel: profile.channel,
    home: profile.home,
    composeProject: profile.composeProject,
    apiUrl: profile.apiUrl,
    ports: profile.ports,
    installed: true,
    healthy: health.healthy,
    runningServices: result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    release: currentRelease(profile),
    syncService: syncServiceStatus(profile),
  };
}
