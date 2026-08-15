import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs';
import { z } from 'zod';
import type { RuntimeChannelProfile } from './runtime-channel.js';
import { writePrivateFileAtomic } from './safe-file.js';

const InstallationCompletionSchema = z.object({
  schemaVersion: z.literal(1),
  channel: z.enum(['stable', 'staging']),
  home: z.string().min(1),
  releaseTag: z.string().regex(/^v\d+\.\d+\.\d+$/),
  ownershipSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

function ownershipSha256(profile: RuntimeChannelProfile): string {
  return createHash('sha256').update(readFileSync(profile.markerFile)).digest('hex');
}

export function installationIsComplete(profile: RuntimeChannelProfile, releaseTag: string): boolean {
  if (!existsSync(profile.completionFile)) return false;
  if (lstatSync(profile.completionFile).isSymbolicLink()) {
    throw new Error('Installation completion state must not be a symbolic link.');
  }
  try {
    const state = InstallationCompletionSchema.parse(JSON.parse(readFileSync(profile.completionFile, 'utf8')));
    return state.channel === profile.channel
      && state.home === profile.home
      && state.releaseTag === releaseTag
      && state.ownershipSha256 === ownershipSha256(profile);
  } catch {
    return false;
  }
}

export function clearInstallationCompletion(profile: RuntimeChannelProfile): void {
  if (!existsSync(profile.completionFile)) return;
  if (lstatSync(profile.completionFile).isSymbolicLink()) {
    throw new Error('Installation completion state must not be a symbolic link.');
  }
  rmSync(profile.completionFile, { force: true });
}

export function writeInstallationCompletion(profile: RuntimeChannelProfile, releaseTag: string): void {
  const contents = `${JSON.stringify(InstallationCompletionSchema.parse({
    schemaVersion: 1,
    channel: profile.channel,
    home: profile.home,
    releaseTag,
    ownershipSha256: ownershipSha256(profile),
  }), null, 2)}\n`;
  writePrivateFileAtomic(profile.completionFile, contents, 'Installation completion state');
}
