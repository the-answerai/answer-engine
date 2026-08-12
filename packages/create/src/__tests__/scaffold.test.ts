import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { scaffoldInstallation } from '../scaffold.js';

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
    expect(readFileSync(result.composePath, 'utf8')).toContain(
      'ghcr.io/the-answerai/answer-engine:1.1.0',
    );
    expect(readFileSync(result.envPath, 'utf8')).toContain(
      'COMPOSE_PROJECT_NAME=answer-engine-local',
    );
    const env = readFileSync(result.envPath, 'utf8');
    expect(env).toContain('AUTH_MODE=api_key');
    expect(env).toContain('STORAGE_DRIVER=local');
    expect(env).toContain(`ENCRYPTION_KEY=${'a'.repeat(64)}`);
    expect(statSync(result.configPath).mode & 0o777).toBe(0o600);
    expect(statSync(result.envPath).mode & 0o777).toBe(0o600);
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
  });
});
