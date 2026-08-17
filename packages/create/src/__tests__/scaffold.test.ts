import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { scaffoldInstallation } from '../scaffold.js';
import { createRuntimeChannelProfile } from '../runtime-channel.js';

const tempDirs: string[] = [];

function tempHome(): string {
  const path = mkdtempSync(join(tmpdir(), 'ae-create-'));
  tempDirs.push(path);
  return path;
}

const config = {
  models: {
    chat: 'qwen2.5',
    embedding: 'nomic-embed-text',
    chat_provider: 'lmstudio' as const,
    embedding_provider: 'lmstudio' as const,
    embedding_dimension: 768,
  },
  sources: [],
  connectors: {},
  server: { port: 5050, bind: '127.0.0.1' },
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('scaffoldInstallation', () => {
  it('writes a secure validated config and pinned Compose runtime', () => {
    const home = tempHome();
    const result = scaffoldInstallation({ home, config }, {
      generateSecret: (name) => name === 'key' ? 'a'.repeat(64) : 'b'.repeat(64),
    });

    expect(parseYaml(readFileSync(result.configPath, 'utf8'))).toEqual(config);
    expect(readFileSync(result.composePath, 'utf8')).toContain('${ANSWER_ENGINE_IMAGE:?');
    expect(readFileSync(result.envPath, 'utf8')).toContain(
      'COMPOSE_PROJECT_NAME=answer-engine-local',
    );
    const env = readFileSync(result.envPath, 'utf8');
    expect(env).toContain(
      `ANSWER_ENGINE_IMAGE=ghcr.io/the-answerai/answer-engine@sha256:${'c0fa1c0f0771800e40b678ff42c43f1c26e322020bec9cd713d7198dd0ab165f'}`,
    );
    expect(env).toContain('AUTH_MODE=api_key');
    expect(env).toContain('LOCAL_UI_AUTO_AUTH=true');
    expect(env).toContain('STORAGE_DRIVER=local');
    expect(env).toContain(`ENCRYPTION_KEY=${'a'.repeat(64)}`);
    expect(statSync(result.configPath).mode & 0o777).toBe(0o600);
    expect(statSync(result.envPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(home, '.release-state.json'), 'utf8'))).toMatchObject({
      schemaVersion: 1,
      current: expect.stringMatching(/@sha256:[a-f0-9]{64}$/),
      previous: expect.stringMatching(/@sha256:[a-f0-9]{64}$/),
      verifiedAtInstall: true,
    });
  });

  it('preserves encryption material and the one-time API key on re-run', () => {
    const home = tempHome();
    const first = scaffoldInstallation({ home, config }, {
      generateSecret: (name) => name === 'key' ? 'a'.repeat(64) : 'b'.repeat(64),
    });
    const withKey = `${readFileSync(first.envPath, 'utf8')}ANSWER_ENGINE_API_KEY=ae_live_once\n`;
    writeFileSync(first.envPath, withKey, 'utf8');

    const second = scaffoldInstallation({ home, config }, {
      generateSecret: () => 'c'.repeat(64),
    });
    const env = readFileSync(second.envPath, 'utf8');

    expect(env).toContain(`ENCRYPTION_KEY=${'a'.repeat(64)}`);
    expect(env).toContain(`ENCRYPTION_SALT=${'b'.repeat(64)}`);
    expect(env).toContain('ANSWER_ENGINE_API_KEY=ae_live_once');
    expect(second.apiKey).toBe('ae_live_once');

    const customConfig = `${readFileSync(second.configPath, 'utf8')}# user note\n`;
    writeFileSync(second.configPath, customConfig, { mode: 0o600 });
    const third = scaffoldInstallation({ home, config }, { generateSecret: () => 'd'.repeat(64) });
    expect(readFileSync(third.configPath, 'utf8')).toBe(customConfig);
    expect(third.changes).toEqual([]);
  });

  it('renders staging-only ports, credentials, volumes, and disabled sync defaults', () => {
    const home = tempHome();
    const profile = createRuntimeChannelProfile('staging', { home });
    const result = scaffoldInstallation({ home, config: { ...config, server: { ...config.server, port: 5150 } }, profile }, {
      generateSecret: (name) => `${name}-staging-secret`,
    });
    const environment = readFileSync(result.envPath, 'utf8');
    const compose = readFileSync(result.composePath, 'utf8');

    expect(environment).toContain('AE_CHANNEL=staging');
    expect(environment).toContain('AE_HISTORY_SYNC_ENABLED=false');
    expect(environment).toContain('COMPOSE_PROJECT_NAME=answer-engine-staging');
    expect(environment).toContain('DATABASE_NAME=answerengine_staging');
    expect(environment).toContain('DATABASE_PASSWORD=database-staging-secret');
    expect(compose).toContain('127.0.0.1:${ANSWER_ENGINE_PORT}:5000');
    expect(compose).toContain('name: answer-engine-staging-postgres');
    expect(compose).toContain('name: answer-engine-staging-redis');
    expect(compose).toContain('name: answer-engine-staging-blobs');
  });

  it('rejects a mutable install image before creating runtime files', () => {
    const home = tempHome();

    expect(() => scaffoldInstallation({
      home, config, image: 'ghcr.io/the-answerai/answer-engine:1.1.0',
    })).toThrow(/exact @sha256 digest/i);
    expect(readdirSync(home)).toEqual([]);
  });
});
