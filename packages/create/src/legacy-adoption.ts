import {
  lstatSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { readEnvValue } from './scaffold.js';
import { writePrivateFileAtomic } from './safe-file.js';
import {
  assertRuntimeChannelConfiguration,
  channelProfiles,
  validateRuntimeChannelIsolation,
  writeRuntimeOwnershipMarker,
  type RuntimeChannelProfile,
} from './runtime-channel.js';

export type LegacyStableInspection =
  | { state: 'available'; message: string }
  | { state: 'unavailable'; message: string }
  | { state: 'invalid'; message: string };

export interface LegacyStableAdoptionResult {
  state: 'adopted';
  home: string;
}

const ComposeServiceSchema = z.record(z.unknown());
const ComposeSchema = z.object({
  services: z.object({
    postgres: ComposeServiceSchema,
    redis: ComposeServiceSchema,
    migrate: ComposeServiceSchema,
    init: ComposeServiceSchema,
    api: ComposeServiceSchema,
  }).strict(),
  volumes: z.record(z.unknown()),
}).passthrough();
const ConfigSchema = z.record(z.unknown());
const REQUIRED_FILES = ['docker-compose.yml', '.env.compose', 'config.yaml'] as const;
const LEGACY_APP_IMAGES = new Set([
  '${ANSWER_ENGINE_IMAGE:-ghcr.io/the-answerai/answer-engine:1.1.2}',
  '${ANSWER_ENGINE_IMAGE:?Set ANSWER_ENGINE_IMAGE to the verified release digest}',
]);

function sameStringArray(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((item, index) => item === expected[index]);
}

function assertServiceField(
  service: Record<string, unknown>,
  field: string,
  expected: string | readonly string[] | undefined,
  label: string,
): void {
  const actual = service[field];
  const matches = Array.isArray(expected)
    ? sameStringArray(actual, expected)
    : actual === expected;
  if (!matches) throw new Error(`${label} has an unexpected ${field} definition.`);
}

function assertLegacyComposeOwnership(
  compose: z.infer<typeof ComposeSchema>,
  profile: RuntimeChannelProfile,
): void {
  if (['include', 'configs', 'secrets'].some((field) => field in compose)) {
    throw new Error('the Compose project uses unsupported external configuration.');
  }
  const forbiddenServiceFields = [
    'build', 'privileged', 'entrypoint', 'cap_add', 'devices', 'device_cgroup_rules',
    'network_mode', 'pid', 'ipc', 'userns_mode', 'security_opt', 'volumes_from',
  ];
  for (const [name, service] of Object.entries(compose.services)) {
    const forbidden = forbiddenServiceFields.find((field) => field in service);
    if (forbidden) throw new Error(`${name} uses unsupported ${forbidden}.`);
  }

  if (typeof compose.services.postgres.image !== 'string'
    || !/^pgvector\/pgvector:pg16(?:@sha256:[a-f0-9]{64})?$/.test(compose.services.postgres.image)) {
    throw new Error('postgres does not use the supported pgvector image.');
  }
  if (typeof compose.services.redis.image !== 'string'
    || !/^redis:7-alpine(?:@sha256:[a-f0-9]{64})?$/.test(compose.services.redis.image)) {
    throw new Error('redis does not use the supported Redis image.');
  }
  for (const name of ['migrate', 'init', 'api'] as const) {
    if (!LEGACY_APP_IMAGES.has(String(compose.services[name].image))) {
      throw new Error(`${name} has an unexpected image definition.`);
    }
    assertServiceField(compose.services[name], 'env_file', ['.env.compose'], name);
  }
  assertServiceField(compose.services.postgres, 'command', undefined, 'postgres');
  assertServiceField(compose.services.redis, 'command', 'redis-server --appendonly yes', 'redis');
  assertServiceField(compose.services.migrate, 'command', ['node', 'dist/scripts/migrate.js'], 'migrate');
  assertServiceField(compose.services.init, 'command', ['node', 'dist/scripts/init.js'], 'init');
  assertServiceField(compose.services.api, 'command', ['node', 'dist/server.js'], 'api');
  assertServiceField(compose.services.postgres, 'volumes', ['postgres_data:/var/lib/postgresql/data'], 'postgres');
  assertServiceField(compose.services.redis, 'volumes', ['redis_data:/data'], 'redis');
  assertServiceField(compose.services.migrate, 'volumes', undefined, 'migrate');
  assertServiceField(compose.services.init, 'volumes', undefined, 'init');
  assertServiceField(compose.services.api, 'volumes', ['answerengine_blobs:/data'], 'api');

  const apiPorts = compose.services.api.ports;
  if (!sameStringArray(apiPorts, [
    `127.0.0.1:${profile.ports.api}:5000`,
  ]) && !sameStringArray(apiPorts, ['127.0.0.1:${ANSWER_ENGINE_PORT}:5000'])) {
    throw new Error('api does not bind only the expected loopback port.');
  }
  const optionalPorts: Array<[Record<string, unknown>, string, string]> = [
    [compose.services.postgres, 'postgres', '127.0.0.1:${DATABASE_PORT_HOST}:5432'],
    [compose.services.redis, 'redis', '127.0.0.1:${REDIS_PORT_HOST}:6379'],
  ];
  for (const [service, name, expected] of optionalPorts) {
    if (service.ports !== undefined && !sameStringArray(service.ports, [expected])) {
      throw new Error(`${name} does not bind only the expected loopback port.`);
    }
  }

  const volumeNames = Object.keys(compose.volumes).sort();
  if (volumeNames.join(',') !== 'answerengine_blobs,postgres_data,redis_data') {
    throw new Error('the Compose project does not declare the Answer Engine volume topology.');
  }
  const expectedVolumeNames = {
    postgres_data: profile.volumes.postgres,
    redis_data: profile.volumes.redis,
    answerengine_blobs: profile.volumes.blobs,
  } as const;
  for (const [name, expected] of Object.entries(expectedVolumeNames)) {
    const definition = compose.volumes[name];
    if (definition === null) continue;
    const parsed = z.object({ name: z.string() }).strict().safeParse(definition);
    if (!parsed.success || parsed.data.name !== expected) {
      throw new Error(`${name} does not resolve to the expected stable volume.`);
    }
  }
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function invalid(message: string): LegacyStableInspection {
  return { state: 'invalid', message: `Refusing stable adoption: ${message}` };
}

function validateRegularFile(path: string, label: string): string | undefined {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) return `${label} must not be a symbolic link.`;
  if (!metadata.isFile()) return `${label} must be a regular file.`;
  return undefined;
}

function validateYamlFiles(profile: RuntimeChannelProfile): string | undefined {
  let composeInput: unknown;
  try {
    composeInput = parseYaml(readFileSync(join(profile.home, 'docker-compose.yml'), 'utf8'));
  } catch {
    return 'docker-compose.yml must be a valid Compose mapping with a services object.';
  }
  const compose = ComposeSchema.safeParse(composeInput);
  if (!compose.success) {
    return 'docker-compose.yml must match the Answer Engine service topology.';
  }
  try {
    assertLegacyComposeOwnership(compose.data, profile);
  } catch (error) {
    return `docker-compose.yml must match the Answer Engine service topology: ${error instanceof Error ? error.message : String(error)}`;
  }
  try {
    ConfigSchema.parse(parseYaml(readFileSync(join(profile.home, 'config.yaml'), 'utf8')));
  } catch {
    return 'config.yaml must be a valid configuration mapping.';
  }
  return undefined;
}

export async function inspectLegacyStableInstallation(
  profile: RuntimeChannelProfile,
): Promise<LegacyStableInspection> {
  if (profile.channel !== 'stable') {
    return { state: 'unavailable', message: 'Only legacy stable installations can be adopted.' };
  }
  if (!pathEntryExists(profile.home)) {
    return { state: 'unavailable', message: 'No existing stable installation was found.' };
  }

  try {
    const homeMetadata = lstatSync(profile.home);
    if (homeMetadata.isSymbolicLink()) return invalid('the runtime home must not be a symbolic link.');
    if (!homeMetadata.isDirectory()) return invalid('the runtime home must be a directory.');

    const requiredPaths = REQUIRED_FILES.map((name) => join(profile.home, name));
    const present = requiredPaths.filter(pathEntryExists);
    if (pathEntryExists(profile.markerFile)) {
      const markerError = validateRegularFile(profile.markerFile, 'the ownership marker');
      return markerError ? invalid(markerError) : {
        state: 'unavailable', message: 'The stable installation already has an ownership marker.',
      };
    }

    for (let index = 0; index < requiredPaths.length; index += 1) {
      const path = requiredPaths[index];
      const name = REQUIRED_FILES[index];
      if (!path || !name || !pathEntryExists(path)) continue;
      const fileError = validateRegularFile(path, name);
      if (fileError) return invalid(fileError);
    }
    if (present.length === 0) {
      return { state: 'unavailable', message: 'No legacy stable installation was found.' };
    }
    if (present.length !== requiredPaths.length) {
      return {
        state: 'unavailable',
        message: 'The stable installation is partial and is not eligible for legacy adoption.',
      };
    }

    const yamlError = validateYamlFiles(profile);
    if (yamlError) return invalid(yamlError);
    assertRuntimeChannelConfiguration(profile, { allowMissingChannel: true });
    await validateRuntimeChannelIsolation(channelProfiles(profile.channel, profile.home));
    return {
      state: 'available',
      message: 'A legacy stable installation can be adopted without restarting or changing data.',
    };
  } catch (error) {
    return invalid(error instanceof Error ? error.message : String(error));
  }
}

export async function adoptLegacyStableInstallation(
  profile: RuntimeChannelProfile,
): Promise<LegacyStableAdoptionResult> {
  const inspection = await inspectLegacyStableInstallation(profile);
  if (inspection.state !== 'available') throw new Error(inspection.message);

  const environment = readFileSync(profile.credentialsFile, 'utf8');
  const existingChannel = readEnvValue(environment, 'AE_CHANNEL');
  if (existingChannel && existingChannel !== 'stable') {
    throw new Error(`Refusing stable adoption: runtime channel is ${existingChannel}; expected stable.`);
  }
  if (!existingChannel) {
    writePrivateFileAtomic(
      profile.credentialsFile,
      `${environment.trimEnd()}\nAE_CHANNEL=stable\n`,
      'Runtime credentials file',
    );
  }
  writeRuntimeOwnershipMarker(profile);
  assertRuntimeChannelConfiguration(profile);
  return { state: 'adopted', home: profile.home };
}
