import {
  existsSync,
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

const ComposeSchema = z.object({
  services: z.record(z.unknown()),
}).passthrough();
const ConfigSchema = z.record(z.unknown());
const REQUIRED_FILES = ['docker-compose.yml', '.env.compose', 'config.yaml'] as const;

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
  try {
    ComposeSchema.parse(parseYaml(readFileSync(join(profile.home, 'docker-compose.yml'), 'utf8')));
  } catch {
    return 'docker-compose.yml must be a valid Compose mapping with a services object.';
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
  if (!existsSync(profile.home)) {
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
