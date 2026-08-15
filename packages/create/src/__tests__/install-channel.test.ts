import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { install } from '../install.js';
import { runPreflight } from '../preflight.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('stable channel adoption', () => {
  it('adds channel ownership to a legacy installer home without touching data or archives', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ae-adopt-'));
    tempDirs.push(home);
    writeFileSync(join(home, 'docker-compose.yml'), 'services: {}\n');
    writeFileSync(join(home, '.env.compose'), 'COMPOSE_PROJECT_NAME=answer-engine-local\nENCRYPTION_KEY=stable-secret\n');
    writeFileSync(join(home, 'config.yaml'), 'models: {}\n');
    writeFileSync(join(home, 'stable-database.fixture'), 'database unchanged');
    writeFileSync(join(home, 'stable-archive.fixture'), 'archive unchanged');
    const messages: string[] = [];

    await install({ channel: 'stable', home, yes: true }, { write: (message) => messages.push(message) }, {
      detectOwnedPorts: async () => new Set(),
      runPreflight: () => runPreflight({
        platform: 'darwin', architecture: 'arm64', totalMemoryBytes: 16 * 1024 ** 3,
        freeDiskBytes: 60 * 1024 ** 3, nodeVersion: '22.16.0', installation: 'legacy',
        modelRuntimeAvailable: true, runCommand: async () => ({ stdout: '' }),
        probePort: async () => true,
      }),
    });

    expect(existsSync(join(home, '.runtime-channel.json'))).toBe(true);
    expect(readFileSync(join(home, '.env.compose'), 'utf8')).toContain('AE_CHANNEL=stable');
    expect(readFileSync(join(home, 'stable-database.fixture'), 'utf8')).toBe('database unchanged');
    expect(readFileSync(join(home, 'stable-archive.fixture'), 'utf8')).toBe('archive unchanged');
    expect(messages.join('\n')).toContain('without restarting or changing data');
  });

  it('cancels a new install before creating or changing any file', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ae-cancel-'));
    tempDirs.push(home);
    const prompt = {
      input: vi.fn(), secret: vi.fn(), select: vi.fn(), confirm: vi.fn(async () => false),
    };
    const modelSetup = {
      config: {
        models: {
          chat: 'small-chat', embedding: 'small-embedding', chat_provider: 'lmstudio' as const,
          embedding_provider: 'lmstudio' as const, embedding_dimension: 768,
        },
        sources: [], connectors: {}, server: { port: 5050, bind: '127.0.0.1' },
      },
      runtime: {},
    };

    await expect(install({ channel: 'stable', home }, { write: vi.fn() }, {
      prompt,
      detectOwnedPorts: async () => new Set(),
      runPreflight: () => runPreflight({
        platform: 'darwin', architecture: 'arm64', totalMemoryBytes: 12 * 1024 ** 3,
        freeDiskBytes: 20 * 1024 ** 3, nodeVersion: '22.16.0', installation: 'absent',
        modelRuntimeAvailable: true, runCommand: async () => ({ stdout: '' }),
        probePort: async () => true,
      }),
      resolveModelSetup: async () => modelSetup,
      selectAgents: async () => [],
    })).rejects.toThrow('cancelled before any changes');

    expect(readdirSync(home)).toEqual([]);
  });
});
