import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getConfigFilePath } from '../config.js';
import { resolveAeHome } from '../home.js';
import { assertHistorySyncAllowed } from '../sync/channel-policy.js';
import { defaultChannelApiUrl } from '../channel.js';

const originalEnvironment = { ...process.env };

afterEach(() => { process.env = { ...originalEnvironment }; });

describe('channel-aware CLI defaults', () => {
  it('keeps stable legacy paths and selects isolated staging defaults', () => {
    delete process.env.AE_HOME;
    delete process.env.ANSWER_ENGINE_API_URL;
    process.env.AE_CHANNEL = 'stable';
    expect(resolveAeHome()).toBe(join(homedir(), '.answer-engine'));
    expect(getConfigFilePath()).toBe(join(homedir(), '.config', 'answer-engine', 'config.yml'));
    expect(defaultChannelApiUrl()).toBe('http://localhost:5050');

    process.env.AE_CHANNEL = 'staging';
    expect(resolveAeHome()).toBe(join(homedir(), '.answer-engine-staging'));
    expect(getConfigFilePath()).toBe(join(homedir(), '.config', 'answer-engine', 'staging.yml'));
    expect(defaultChannelApiUrl()).toBe('http://127.0.0.1:5150');
  });

  it('refuses staging history sync until persisted opt-in and command confirmation coexist', () => {
    process.env.AE_CHANNEL = 'staging';
    expect(() => assertHistorySyncAllowed({ enabled: false }, true)).toThrow(/disabled/i);
    expect(() => assertHistorySyncAllowed({ enabled: true }, false)).toThrow(/confirm/i);
    expect(() => assertHistorySyncAllowed({ enabled: true }, true)).not.toThrow();
  });

  it('does not require an extra confirmation on stable', () => {
    process.env.AE_CHANNEL = 'stable';
    expect(() => assertHistorySyncAllowed(undefined, false)).not.toThrow();
  });
});
