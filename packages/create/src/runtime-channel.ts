import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

export const RuntimeChannelSchema = z.enum(['stable', 'staging']);
export type RuntimeChannel = z.infer<typeof RuntimeChannelSchema>;

const PortSchema = z.number().int().min(1).max(65_535);
const NonEmptySchema = z.string().trim().min(1);

export const RuntimeChannelProfileSchema = z.object({
  channel: RuntimeChannelSchema,
  home: NonEmptySchema,
  dataDir: NonEmptySchema,
  logsDir: NonEmptySchema,
  rawArchiveDir: NonEmptySchema,
  credentialsFile: NonEmptySchema,
  markerFile: NonEmptySchema,
  releaseFile: NonEmptySchema,
  composeProject: NonEmptySchema,
  databaseName: NonEmptySchema,
  apiUrl: z.string().url(),
  ports: z.object({ api: PortSchema, database: PortSchema, redis: PortSchema, web: PortSchema, mcp: PortSchema }).strict(),
  volumes: z.object({ postgres: NonEmptySchema, redis: NonEmptySchema, blobs: NonEmptySchema }).strict(),
  sync: z.object({
    enabledByDefault: z.boolean(),
    launchdLabel: NonEmptySchema,
    systemdUnit: NonEmptySchema,
  }).strict(),
}).strict();

export type RuntimeChannelProfile = z.infer<typeof RuntimeChannelProfileSchema>;

export interface RuntimeChannelOverrides {
  home?: string;
}

interface RuntimeChannelConfigurationOptions {
  allowMissingChannel?: boolean;
}

const DEFAULTS = {
  stable: {
    homeName: '.answer-engine', composeProject: 'answer-engine-local', databaseName: 'answerengine',
    ports: { api: 5050, database: 5433, redis: 6380, web: 3200, mcp: 5051 },
    volumes: { postgres: 'answer-engine-local_postgres_data', redis: 'answer-engine-local_redis_data', blobs: 'answer-engine-local_answerengine_blobs' },
    sync: { enabledByDefault: true, launchdLabel: 'ai.answer-engine.sync', systemdUnit: 'answer-engine-sync.service' },
  },
  staging: {
    homeName: '.answer-engine-staging', composeProject: 'answer-engine-staging', databaseName: 'answerengine_staging',
    ports: { api: 5150, database: 5533, redis: 6480, web: 3300, mcp: 5151 },
    volumes: { postgres: 'answer-engine-staging-postgres', redis: 'answer-engine-staging-redis', blobs: 'answer-engine-staging-blobs' },
    sync: { enabledByDefault: false, launchdLabel: 'ai.answer-engine.staging.sync', systemdUnit: 'answer-engine-staging-sync.service' },
  },
} as const;

export function parseRuntimeChannel(value: unknown): RuntimeChannel {
  const result = RuntimeChannelSchema.safeParse(value ?? 'stable');
  if (!result.success) throw new Error('--channel must be stable or staging.');
  return result.data;
}

export function createRuntimeChannelProfile(
  channel: RuntimeChannel,
  overrides: RuntimeChannelOverrides = {},
): RuntimeChannelProfile {
  const defaults = DEFAULTS[channel];
  const home = resolve(overrides.home ?? join(homedir(), defaults.homeName));
  return RuntimeChannelProfileSchema.parse({
    channel,
    home,
    dataDir: join(home, 'data'),
    logsDir: join(home, 'logs'),
    rawArchiveDir: join(home, 'raw-archive'),
    credentialsFile: join(home, '.env.compose'),
    markerFile: join(home, '.runtime-channel.json'),
    releaseFile: join(home, '.release-state.json'),
    composeProject: defaults.composeProject,
    databaseName: defaults.databaseName,
    apiUrl: channel === 'stable' ? 'http://localhost:5050' : `http://127.0.0.1:${defaults.ports.api}`,
    ports: defaults.ports,
    volumes: defaults.volumes,
    sync: defaults.sync,
  });
}

export function writeRuntimeOwnershipMarker(profile: RuntimeChannelProfile): void {
  const composeFile = join(profile.home, 'docker-compose.yml');
  const contents = `${JSON.stringify({
    schemaVersion: 2,
    channel: profile.channel,
    home: profile.home,
    composeProject: profile.composeProject,
    ports: profile.ports,
    volumes: profile.volumes,
    databaseName: profile.databaseName,
    composeFileSha256: createHash('sha256').update(readFileSync(composeFile)).digest('hex'),
  }, null, 2)}\n`;
  if (existsSync(profile.markerFile) && readFileSync(profile.markerFile, 'utf8') === contents) return;
  writeFileSync(profile.markerFile, contents, { encoding: 'utf8', mode: 0o600 });
  chmodSync(profile.markerFile, 0o600);
}

function environmentValue(contents: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const raw = [...contents.matchAll(new RegExp(`^\\s*${escaped}\\s*=\\s*(.*)$`, 'gm'))].at(-1)?.[1]?.trim();
  if (!raw) return undefined;
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return typeof parsed === 'string' ? parsed : raw;
    } catch {
      return raw;
    }
  }
  return raw;
}

export function assertRuntimeChannelConfiguration(
  profile: RuntimeChannelProfile,
  options: RuntimeChannelConfigurationOptions = {},
): void {
  if (!existsSync(profile.credentialsFile)) {
    throw new Error(`Runtime credentials file is missing for ${profile.channel}.`);
  }
  if (lstatSync(profile.credentialsFile).isSymbolicLink()) {
    throw new Error(`Runtime credentials file must not be a symbolic link for ${profile.channel}.`);
  }
  const environment = readFileSync(profile.credentialsFile, 'utf8');
  const actualProject = environmentValue(environment, 'COMPOSE_PROJECT_NAME');
  if (actualProject !== profile.composeProject) {
    throw new Error(
      `Runtime Compose project is ${actualProject ?? '(missing)'}; expected ${profile.composeProject} for ${profile.channel}.`,
    );
  }
  const actualChannel = environmentValue(environment, 'AE_CHANNEL');
  if (actualChannel !== profile.channel && !(options.allowMissingChannel && actualChannel === undefined)) {
    throw new Error(
      `Runtime channel is ${actualChannel ?? '(missing)'}; expected ${profile.channel}.`,
    );
  }

  const expectedModernResources: Record<string, string> = {
    AE_HISTORY_SYNC_ENABLED: String(profile.sync.enabledByDefault),
    ANSWER_ENGINE_SYNC_ENABLED: String(profile.sync.enabledByDefault),
    ANSWER_ENGINE_PORT: String(profile.ports.api),
    DATABASE_PORT_HOST: String(profile.ports.database),
    REDIS_PORT_HOST: String(profile.ports.redis),
    WEB_UI_PORT: String(profile.ports.web),
    ANSWER_ENGINE_MCP_PORT: String(profile.ports.mcp),
    DATABASE_NAME: profile.databaseName,
  };
  const modernDiscriminators = Object.keys(expectedModernResources)
    .filter((key) => key !== 'DATABASE_NAME');
  const modern = profile.channel === 'staging'
    || modernDiscriminators.some((key) => environmentValue(environment, key) !== undefined);
  if (modern) {
    for (const [key, expected] of Object.entries(expectedModernResources)) {
      const actual = environmentValue(environment, key);
      if (actual !== expected) {
        throw new Error(
          `Runtime ${key} is ${actual ?? '(missing)'}; expected ${expected} for ${profile.channel}.`,
        );
      }
    }
  } else {
    const legacyDatabase = environmentValue(environment, 'DATABASE_NAME');
    if (legacyDatabase !== undefined && legacyDatabase !== profile.databaseName) {
      throw new Error(
        `Runtime DATABASE_NAME is ${legacyDatabase}; expected ${profile.databaseName} for stable.`,
      );
    }
  }
}

function canonicalPath(path: string): string {
  const target = resolve(path);
  try {
    if (lstatSync(target).isSymbolicLink()) return realpathSync.native(target);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    try {
      if (lstatSync(target).isSymbolicLink()) {
        throw new Error(`Unresolved symbolic-link runtime path: ${target}`);
      }
    } catch (linkError) {
      if (!(linkError instanceof Error && 'code' in linkError && linkError.code === 'ENOENT')) throw linkError;
    }
  }
  if (existsSync(target)) return realpathSync.native(target);
  let ancestor = dirname(target);
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
  const canonicalAncestor = existsSync(ancestor) ? realpathSync.native(ancestor) : ancestor;
  return resolve(canonicalAncestor, relative(ancestor, target));
}

function pathsOverlap(left: string, right: string): boolean {
  const fromLeft = relative(left, right);
  const fromRight = relative(right, left);
  const contained = (value: string) => value === ''
    || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value));
  return contained(fromLeft) || contained(fromRight);
}

function credentialFingerprints(path: string): Map<string, string> {
  if (!existsSync(path)) return new Map();
  const contents = readFileSync(path, 'utf8');
  const values = ['DATABASE_PASSWORD', 'ENCRYPTION_KEY', 'ENCRYPTION_SALT', 'ANSWER_ENGINE_API_KEY']
    .map((key) => [key, environmentValue(contents, key)] as const)
    .filter((entry): entry is readonly [string, string] => Boolean(entry[1]));
  return new Map(values.map(([key, value]) => [key, createHash('sha256').update(value).digest('hex')]));
}

export async function validateRuntimeChannelIsolation(
  inputProfiles: readonly RuntimeChannelProfile[],
): Promise<void> {
  const profiles = inputProfiles.map((profile) => RuntimeChannelProfileSchema.parse(profile));
  if (profiles.length < 2) throw new Error('Runtime isolation validation requires both channels.');
  const channelNames = new Set(profiles.map((profile) => profile.channel));
  if (channelNames.size !== profiles.length) throw new Error('Runtime channel identity collision.');
  for (const profile of profiles) {
    if (new Set(Object.values(profile.ports)).size !== Object.values(profile.ports).length) {
      throw new Error(`Port collision inside the ${profile.channel} runtime channel.`);
    }
    if (new Set(Object.values(profile.volumes)).size !== Object.values(profile.volumes).length) {
      throw new Error(`Volume name collision inside the ${profile.channel} runtime channel.`);
    }
    if (existsSync(profile.markerFile)) assertRuntimeChannelConfiguration(profile);
  }

  for (let leftIndex = 0; leftIndex < profiles.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < profiles.length; rightIndex += 1) {
      const left = profiles[leftIndex];
      const right = profiles[rightIndex];
      if (!left || !right) continue;
      const leftPaths = [left.home, left.dataDir, left.logsDir, left.rawArchiveDir, left.credentialsFile];
      const rightPaths = [right.home, right.dataDir, right.logsDir, right.rawArchiveDir, right.credentialsFile];
      for (const leftPath of leftPaths) {
        for (const rightPath of rightPaths) {
          if (pathsOverlap(canonicalPath(leftPath), canonicalPath(rightPath))) {
            throw new Error(`Runtime path overlap between ${left.channel} and ${right.channel}.`);
          }
        }
      }

      const scalarPairs: Array<[string, string, string]> = [
        ['Compose project', left.composeProject, right.composeProject],
        ['database name', left.databaseName, right.databaseName],
        ['launch service', left.sync.launchdLabel, right.sync.launchdLabel],
        ['systemd service', left.sync.systemdUnit, right.sync.systemdUnit],
      ];
      for (const [label, leftValue, rightValue] of scalarPairs) {
        if (leftValue === rightValue) throw new Error(`${label} collision between runtime channels.`);
      }
      const leftPorts = new Set(Object.values(left.ports));
      for (const port of Object.values(right.ports)) {
        if (leftPorts.has(port)) throw new Error(`Port collision between runtime channels: ${port}.`);
      }
      const leftVolumes = new Set(Object.values(left.volumes));
      for (const volume of Object.values(right.volumes)) {
        if (leftVolumes.has(volume)) throw new Error('Volume name collision between runtime channels.');
      }
      const leftCredentials = credentialFingerprints(left.credentialsFile);
      const rightCredentials = credentialFingerprints(right.credentialsFile);
      for (const [leftKey, leftFingerprint] of leftCredentials) {
        for (const [rightKey, rightFingerprint] of rightCredentials) {
          if (leftFingerprint === rightFingerprint) {
            throw new Error(`Credential fingerprint collision (${leftKey}/${rightKey}) between runtime channels.`);
          }
        }
      }
    }
  }
}

export function channelProfiles(selected: RuntimeChannel, home?: string): RuntimeChannelProfile[] {
  return (['stable', 'staging'] as const).map((channel) => createRuntimeChannelProfile(
    channel,
    channel === selected && home
      ? { home }
      : process.env[channel === 'stable' ? 'AE_STABLE_HOME' : 'AE_STAGING_HOME']
        ? { home: process.env[channel === 'stable' ? 'AE_STABLE_HOME' : 'AE_STAGING_HOME'] }
        : {},
  ));
}
