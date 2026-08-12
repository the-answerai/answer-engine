import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_USER_CONFIG,
  UserConfigSchema,
  loadUserConfig,
} from '../user-config.js';

const tempDirs: string[] = [];

function writeConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ae-user-config-'));
  tempDirs.push(dir);
  const path = join(dir, 'config.yaml');
  writeFileSync(path, contents, 'utf8');
  return path;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('UserConfigSchema', () => {
  it('applies local server, source, and connector defaults', () => {
    const config = UserConfigSchema.parse({
      models: {
        chat: 'local-chat-model',
        embedding: 'local-embedding-model',
        chat_provider: 'lmstudio',
        embedding_provider: 'lmstudio',
        embedding_dimension: 768,
      },
    });

    expect(config.server).toEqual({ port: 5050, bind: '127.0.0.1' });
    expect(config.sources).toEqual([]);
    expect(config.connectors).toEqual({});
  });

  it('exports a valid fully local default configuration', () => {
    expect(UserConfigSchema.parse(DEFAULT_USER_CONFIG)).toEqual(DEFAULT_USER_CONFIG);
  });

  it('accepts Codex path sources and rejects URL-backed Codex sources', () => {
    const models = {
      chat: 'local-chat-model',
      embedding: 'local-embedding-model',
      chat_provider: 'lmstudio' as const,
      embedding_provider: 'lmstudio' as const,
      embedding_dimension: 768,
    };
    expect(UserConfigSchema.parse({
      models,
      sources: [{ type: 'codex', path: '/tmp/codex' }],
    }).sources).toEqual([{ type: 'codex', path: '/tmp/codex' }]);
    expect(() => UserConfigSchema.parse({
      models,
      sources: [{ type: 'codex', url: 'https://example.com/codex' }],
    })).toThrow(/is not supported for codex; use path instead/);
  });

  it('accepts Cowork path sources and rejects URL-backed Cowork sources', () => {
    const models = {
      chat: 'local-chat-model',
      embedding: 'local-embedding-model',
      chat_provider: 'lmstudio' as const,
      embedding_provider: 'lmstudio' as const,
      embedding_dimension: 768,
    };
    expect(UserConfigSchema.parse({
      models,
      sources: [{ type: 'cowork', path: '/tmp/cowork' }],
    }).sources).toEqual([{ type: 'cowork', path: '/tmp/cowork' }]);
    expect(() => UserConfigSchema.parse({
      models,
      sources: [{ type: 'cowork', url: 'https://example.com/cowork' }],
    })).toThrow(/is not supported for cowork; use path instead/);
  });

  it('validates local directory source options and requires a path', () => {
    const models = {
      chat: 'local-chat-model',
      embedding: 'local-embedding-model',
      chat_provider: 'lmstudio' as const,
      embedding_provider: 'lmstudio' as const,
      embedding_dimension: 768,
    };
    expect(UserConfigSchema.parse({
      models,
      sources: [{
        type: 'local_dir',
        path: '/tmp/notes',
        include: ['**/*.md'],
        exclude: ['private/**'],
        content_type: 'document',
        on_delete: 'forget',
        max_file_bytes: 1024,
      }],
    }).sources).toEqual([{
      type: 'local_dir',
      path: '/tmp/notes',
      include: ['**/*.md'],
      exclude: ['private/**'],
      content_type: 'document',
      on_delete: 'forget',
      max_file_bytes: 1024,
    }]);
    expect(() => UserConfigSchema.parse({
      models,
      sources: [{ type: 'local_dir' }],
    })).toThrow(/path.*required for local_dir/s);
    expect(() => UserConfigSchema.parse({
      models,
      sources: [{ type: 'local_dir', path: '/tmp/notes', url: 'https://example.com' }],
    })).toThrow(/is not supported for local_dir/);
  });
});

describe('loadUserConfig', () => {
  it('loads models, sources, connector keys, and server settings from YAML', () => {
    const path = writeConfig(`
models:
  chat: qwen-local
  embedding: nomic-embed
  chat_provider: lmstudio
  embedding_provider: lmstudio
  embedding_dimension: 768
sources:
  - type: claude-code
    path: /tmp/transcripts
    library: personal-memory
    options:
      include_archived: false
connectors:
  anthropic_api_key: sk-ant-test
server:
  port: 6060
  bind: 0.0.0.0
`);

    expect(loadUserConfig(path)).toMatchObject({
      models: { chat: 'qwen-local', embedding_dimension: 768 },
      sources: [{ type: 'claude-code', path: '/tmp/transcripts', library: 'personal-memory' }],
      connectors: { anthropic_api_key: 'sk-ant-test' },
      server: { port: 6060, bind: '0.0.0.0' },
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('reports the file and exact invalid field with an actionable message', () => {
    const path = writeConfig(`
models:
  chat: local-chat
  embedding: local-embedding
  chat_provider: lmstudio
  embedding_provider: lmstudio
  embedding_dimension: 0
`);

    expect(() => loadUserConfig(path)).toThrow(
      new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*models\\.embedding_dimension.*greater than 0`, 's'),
    );
  });

  it('explains how to recover when config.yaml is missing', () => {
    const path = join(tmpdir(), 'missing-ae-config', 'config.yaml');

    expect(() => loadUserConfig(path)).toThrow(/Unable to read Answer Engine config.*Create it/);
  });
});
