import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { renderEnvFromConfig, writeEnvFile } from '../env-generator.js';
import { UserConfigSchema } from '../user-config.js';

const originalAeHome = process.env.AE_HOME;
const tempDirs: string[] = [];

function localConfig() {
  return UserConfigSchema.parse({
    models: {
      chat: 'qwen2.5',
      embedding: 'nomic-embed-text',
      chat_provider: 'lmstudio',
      embedding_provider: 'lmstudio',
      embedding_dimension: 768,
    },
    connectors: {
      anthropic_api_key: 'sk-ant-test',
      openai_api_key: 'sk-openai-test',
    },
    server: { port: 5050, bind: '127.0.0.1' },
  });
}

afterEach(() => {
  if (originalAeHome === undefined) delete process.env.AE_HOME;
  else process.env.AE_HOME = originalAeHome;

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('renderEnvFromConfig', () => {
  it('round-trips all local operating modes, models, server settings, and connector keys', () => {
    process.env.AE_HOME = '/tmp/answer engine';

    const rendered = renderEnvFromConfig(localConfig());

    expect(rendered).toContain('AUTH_MODE=api_key\n');
    expect(rendered).toContain('STORAGE_DRIVER=local\n');
    expect(rendered).toContain('AE_HOME="/tmp/answer engine"\n');
    expect(rendered).toContain('LLM_PROVIDER=lmstudio\n');
    expect(rendered).toContain('MODELS_CHAT=qwen2.5\n');
    expect(rendered).toContain('EMBEDDING_PROVIDER=lmstudio\n');
    expect(rendered).toContain('MODELS_EMBEDDING=nomic-embed-text\n');
    expect(rendered).toContain('EMBEDDING_DIMENSION=768\n');
    expect(rendered).toContain('PORT=5050\n');
    expect(rendered).toContain('HOST=127.0.0.1\n');
    expect(rendered).toContain('ANTHROPIC_API_KEY=sk-ant-test\n');
    expect(rendered).toContain('OPENAI_API_KEY=sk-openai-test\n');
  });
});

describe('writeEnvFile', () => {
  it('preserves bootstrap values, replaces generated values, and enforces owner-only permissions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ae-env-'));
    tempDirs.push(dir);
    process.env.AE_HOME = dir;
    const path = join(dir, '.env');
    writeFileSync(
      path,
      [
        '# bootstrap-managed',
        'DEFAULT_TENANT_ID=tenant-123',
        'ANSWER_ENGINE_API_KEY=ae_live_test',
        'LLM_PROVIDER=legacy',
        '',
      ].join('\n'),
      { encoding: 'utf8', mode: 0o644 },
    );

    writeEnvFile(localConfig(), path);

    const contents = readFileSync(path, 'utf8');
    expect(contents).toContain('DEFAULT_TENANT_ID=tenant-123');
    expect(contents).toContain('ANSWER_ENGINE_API_KEY=ae_live_test');
    expect(contents).not.toContain('LLM_PROVIDER=legacy');
    expect(contents.match(/^LLM_PROVIDER=/gm)).toHaveLength(1);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
