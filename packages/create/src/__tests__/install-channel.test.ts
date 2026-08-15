import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { persistApiKey } from '../docker.js';
import { install } from '../install.js';
import type { InstallDependencies } from '../install.js';
import { runPreflight } from '../preflight.js';
import { createRuntimeChannelProfile } from '../runtime-channel.js';

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

    const messages: string[] = [];
    await expect(install({ channel: 'stable', home }, { write: (message) => messages.push(message) }, {
      prompt,
      detectOwnedPorts: async () => new Set(),
      runPreflight: () => runPreflight({
        platform: 'darwin', architecture: 'arm64', totalMemoryBytes: 12 * 1024 ** 3,
        freeDiskBytes: 20 * 1024 ** 3, nodeVersion: '22.16.0', installation: 'absent',
        modelRuntimeAvailable: true, runCommand: async () => ({ stdout: '' }),
        probePort: async () => true,
      }),
      resolveModelSetup: async () => modelSetup,
      selectClients: async () => ['codex'],
    })).rejects.toThrow('cancelled before any changes');

    expect(readdirSync(home)).toEqual([]);
    expect(messages.join('\n')).toContain('.codex/config.toml');
    expect(messages.join('\n')).toContain('.agents/plugins/marketplace.json');
    expect(prompt.confirm).toHaveBeenCalledOnce();
  });

  it('resumes final verification after a healthy partial run, then makes completed retries no-ops', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ae-resume-'));
    tempDirs.push(home);
    const profile = createRuntimeChannelProfile('stable', { home });
    let installation: 'absent' | 'managed' = 'absent';
    const verifyMemoryRoundTrip = vi.fn()
      .mockRejectedValueOnce(new Error('simulated verification failure'))
      .mockResolvedValue('content-verified');
    const applyIntegrationPlan = vi.fn(async () => ({
      changed: 0,
      ledger: {
        schemaVersion: 1 as const, channel: 'stable' as const, home, clients: [], entries: [], verification: [],
      },
    }));
    const startStack = vi.fn(async () => 'ae_live_resume_test_key_1234567890');
    const activateApiKey = vi.fn(async (_home: string, envPath: string, apiKey: string) => {
      persistApiKey(envPath, apiKey);
      installation = 'managed';
    });
    const modelSetup = {
      config: {
        models: {
          chat: 'gpt-test', embedding: 'text-embedding-3-small', chat_provider: 'openai' as const,
          embedding_provider: 'openai' as const, embedding_dimension: 1536,
        },
        sources: [], connectors: { openai_api_key: 'test-provider-key' },
        server: { port: 5050, bind: '127.0.0.1' },
      },
      runtime: {},
    };
    const dependencies: InstallDependencies = {
      detectOwnedPorts: async () => new Set<number>(),
      runPreflight: () => runPreflight({
        platform: 'darwin', architecture: 'arm64', totalMemoryBytes: 16 * 1024 ** 3,
        freeDiskBytes: 60 * 1024 ** 3, nodeVersion: '22.16.0', installation,
        modelRuntimeAvailable: true, runCommand: async () => ({ stdout: '' }),
        probePort: async () => true,
      }),
      runLifecycleAction: async () => ({
        channel: profile.channel, home, composeProject: profile.composeProject, apiUrl: profile.apiUrl,
        ports: profile.ports, installed: true, healthy: true, runningServices: ['api', 'postgres', 'redis'],
        syncService: {
          launchdLabel: profile.sync.launchdLabel,
          systemdUnit: profile.sync.systemdUnit,
          enabledByDefault: profile.sync.enabledByDefault,
          historyAccessEnabled: true,
          installed: false,
        },
      }),
      resolveModelSetup: async () => modelSetup,
      selectClients: async () => ['codex'],
      startStack,
      activateApiKey,
      applyIntegrationPlan,
      verifyMemoryRoundTrip,
      verifyClientIntegrations: async () => [
        { client: 'codex' as const, status: 'passed' as const, detail: 'Verified a real recall tool call.' },
      ],
      updateIntegrationVerification: vi.fn(),
    };

    await expect(install({ channel: 'stable', home, yes: true }, { write: vi.fn() }, dependencies))
      .rejects.toThrow('simulated verification failure');
    await expect(install({ channel: 'stable', home, yes: true }, { write: vi.fn() }, dependencies))
      .resolves.toBeUndefined();

    expect(verifyMemoryRoundTrip).toHaveBeenCalledTimes(2);
    expect(applyIntegrationPlan).toHaveBeenCalledTimes(2);
    expect(existsSync(join(home, '.install-complete.json'))).toBe(true);

    await expect(install({ channel: 'stable', home, yes: true }, { write: vi.fn() }, dependencies))
      .resolves.toBeUndefined();
    expect(verifyMemoryRoundTrip).toHaveBeenCalledTimes(2);
    expect(applyIntegrationPlan).toHaveBeenCalledTimes(2);
  });
});
