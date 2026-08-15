import { homedir } from 'node:os';
import { join } from 'node:path';

export type RuntimeChannel = 'stable' | 'staging';

export function resolveRuntimeChannel(value: string | undefined = process.env.AE_CHANNEL): RuntimeChannel {
  const channel = value?.trim() || 'stable';
  if (channel !== 'stable' && channel !== 'staging') {
    throw new Error('AE_CHANNEL must be stable or staging');
  }
  return channel;
}

export function defaultChannelHome(channel: RuntimeChannel = resolveRuntimeChannel()): string {
  return join(homedir(), channel === 'stable' ? '.answer-engine' : '.answer-engine-staging');
}

export function defaultChannelApiUrl(channel: RuntimeChannel = resolveRuntimeChannel()): string {
  return channel === 'stable' ? 'http://localhost:5050' : 'http://127.0.0.1:5150';
}

export function defaultChannelConfigFile(channel: RuntimeChannel = resolveRuntimeChannel()): string {
  return join(homedir(), '.config', 'answer-engine', channel === 'stable' ? 'config.yml' : 'staging.yml');
}
