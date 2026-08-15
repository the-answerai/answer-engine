import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  applyIntegrationPlan,
  buildIntegrationPlan,
  integrationLedgerIsCurrent,
  readIntegrationLedger,
  removeManagedIntegrations,
  resolveDockerExecutable,
} from '../integrations.js';

const tempDirs: string[] = [];
const dockerCommand = '/usr/local/bin/docker';

function fixture(): { aeHome: string; homeDir: string; templateDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'ae-integrations-'));
  tempDirs.push(root);
  const aeHome = join(root, 'answer-engine');
  const homeDir = join(root, 'user');
  const templateDir = join(root, 'template');
  mkdirSync(join(templateDir, '.codex-plugin'), { recursive: true });
  mkdirSync(join(templateDir, '.claude-plugin'), { recursive: true });
  mkdirSync(join(templateDir, 'skills', 'use-answer-engine'), { recursive: true });
  writeFileSync(join(templateDir, '.codex-plugin', 'plugin.json'), '{"name":"answer-engine"}\n');
  writeFileSync(join(templateDir, '.claude-plugin', 'plugin.json'), '{"name":"answer-engine"}\n');
  writeFileSync(join(templateDir, '.mcp.json'), JSON.stringify({
    mcpServers: {
      'answer-engine': {
        command: '__ANSWER_ENGINE_MCP_COMMAND__', args: [], env: {},
      },
    },
  }));
  writeFileSync(join(templateDir, 'skills', 'use-answer-engine', 'SKILL.md'), '---\nname: use-answer-engine\n---\n');
  return { aeHome, homeDir, templateDir };
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('integration plan/apply/remove', () => {
  it('shows every target and limitation without secrets before mutation', () => {
    const { aeHome, homeDir } = fixture();
    const plan = buildIntegrationPlan({
      channel: 'stable', aeHome, homeDir,
      clients: ['codex', 'chatgpt-web', 'claude-code', 'claude-cowork'],
      coworkMode: 'remote',
    });

    expect(plan.operations.map((operation) => operation.path)).toEqual(expect.arrayContaining([
      join(homeDir, '.agents', 'plugins', 'marketplace.json'),
      join(homeDir, '.agents', 'plugins', 'plugins', 'answer-engine'),
      join(aeHome, 'client-plugins', 'claude-marketplace'),
      join(homeDir, '.config', 'answer-engine', 'config.yml'),
    ]));
    expect(plan.clients.find((client) => client.id === 'chatgpt-web')?.limitation)
      .toMatch(/remote mcp/i);
    expect(plan.clients.find((client) => client.id === 'claude-cowork')?.limitation)
      .toMatch(/cannot reach localhost/i);
    expect(JSON.stringify(plan)).not.toContain('ae_live_');
    expect(existsSync(aeHome)).toBe(false);
  });

  it('applies byte-stably, stores private redacted ledger/backups, and writes CLI handoff', async () => {
    const { aeHome, homeDir, templateDir } = fixture();
    const codexConfig = join(homeDir, '.codex', 'config.toml');
    const cliConfigPath = join(homeDir, '.config', 'answer-engine', 'config.yml');
    mkdirSync(join(homeDir, '.codex'), { recursive: true });
    mkdirSync(join(homeDir, '.config', 'answer-engine'), { recursive: true });
    writeFileSync(codexConfig, '[mcp_servers.filesystem]\ncommand = "node"\nargs = ["fs.js"]\n');
    writeFileSync(cliConfigPath, 'default_output: table\n');
    const plan = buildIntegrationPlan({
      channel: 'stable', aeHome, homeDir, clients: ['codex', 'claude-code', 'chatgpt-desktop'],
    });
    const runCommand = vi.fn(async () => ({ stdout: '{"installed":true}', stderr: '' }));

    const first = await applyIntegrationPlan(plan, {
      apiKey: 'ae_live_super_secret_key', apiUrl: 'http://127.0.0.1:5050', templateDir, runCommand,
      dockerCommand,
    });
    const firstBytes = new Map(plan.operations
      .filter((operation) => operation.kind !== 'plugin-command')
      .map((operation) => [operation.path, existsSync(operation.path) && statSync(operation.path).isFile()
        ? readFileSync(operation.path) : undefined]));
    const second = await applyIntegrationPlan(plan, {
      apiKey: 'ae_live_super_secret_key', apiUrl: 'http://127.0.0.1:5050', templateDir, runCommand,
      dockerCommand,
    });

    expect(first.changed).toBeGreaterThan(0);
    expect(second.changed).toBe(0);
    for (const [path, bytes] of firstBytes) {
      if (bytes) expect(readFileSync(path)).toEqual(bytes);
    }
    expect(readFileSync(codexConfig, 'utf8')).toContain('[mcp_servers.filesystem]');
    const cliConfig = parseYaml(readFileSync(cliConfigPath, 'utf8')) as Record<string, unknown>;
    expect(cliConfig).toMatchObject({
      default_output: 'table', api_key: 'ae_live_super_secret_key', api_url: 'http://127.0.0.1:5050',
    });
    const ledger = readIntegrationLedger(aeHome);
    expect(JSON.stringify(ledger)).not.toContain('ae_live_super_secret_key');
    expect(statSync(join(aeHome, 'integrations', 'ledger.json')).mode & 0o777).toBe(0o600);
    expect(ledger.entries.some((entry) => entry.backupPath)).toBe(true);
    expect(runCommand).toHaveBeenCalledWith('codex', ['plugin', 'add', 'answer-engine@personal', '--json']);
    expect(runCommand).toHaveBeenCalledWith('claude', [
      'plugin', 'marketplace', 'add', join(aeHome, 'client-plugins', 'claude-marketplace'), '--scope', 'user',
    ]);
    expect(runCommand).toHaveBeenCalledWith('claude', [
      'plugin', 'install', 'answer-engine@answer-engine', '--scope', 'user',
    ]);
    const installedMcp = JSON.parse(readFileSync(
      join(homeDir, '.agents', 'plugins', 'plugins', 'answer-engine', '.mcp.json'),
      'utf8',
    )) as { mcpServers: { 'answer-engine': { command: string; args: string[]; env: Record<string, string> } } };
    expect(installedMcp.mcpServers['answer-engine']).toMatchObject({
      command: dockerCommand,
      args: expect.arrayContaining([
        'exec', '-T', '-e', 'ANSWER_ENGINE_API_URL=http://127.0.0.1:5000',
        'api', 'node', '/app/packages/mcp-server/dist/index.js',
      ]),
      env: {},
    });
    expect(JSON.stringify(installedMcp)).not.toContain('ae_live_super_secret_key');
    const installedCodexManifest = JSON.parse(readFileSync(
      join(homeDir, '.agents', 'plugins', 'plugins', 'answer-engine', '.codex-plugin', 'plugin.json'),
      'utf8',
    )) as { mcpServers: Record<string, unknown> };
    expect(installedCodexManifest.mcpServers).toHaveProperty('answer-engine');
  });

  it('preserves an existing Codex marketplace name and installs through that marketplace', async () => {
    const { aeHome, homeDir, templateDir } = fixture();
    const marketplacePath = join(homeDir, '.agents', 'plugins', 'marketplace.json');
    mkdirSync(join(homeDir, '.agents', 'plugins'), { recursive: true });
    writeFileSync(marketplacePath, `${JSON.stringify({
      name: 'local',
      interface: { displayName: 'Local Plugins' },
      plugins: [{
        name: 'existing-plugin',
        source: { source: 'local', path: './plugins/existing-plugin' },
      }],
    }, null, 2)}\n`);
    const plan = buildIntegrationPlan({
      channel: 'stable', aeHome, homeDir, clients: ['codex'],
    });
    const runCommand = vi.fn(async () => ({ stdout: '{"installed":true}', stderr: '' }));

    await applyIntegrationPlan(plan, {
      apiKey: 'ae_live_marketplace_secret', apiUrl: 'http://127.0.0.1:5050', templateDir, runCommand,
      dockerCommand,
    });

    const marketplace = JSON.parse(readFileSync(marketplacePath, 'utf8')) as {
      name: string;
      plugins: Array<{ name: string }>;
    };
    expect(marketplace.name).toBe('local');
    expect(marketplace.plugins.map((plugin) => plugin.name)).toEqual([
      'existing-plugin', 'answer-engine',
    ]);
    expect(runCommand).toHaveBeenCalledWith('codex', [
      'plugin', 'add', 'answer-engine@local', '--json',
    ]);

    await removeManagedIntegrations(aeHome, { runCommand });

    expect(runCommand).toHaveBeenCalledWith('codex', [
      'plugin', 'remove', 'answer-engine@local', '--json',
    ]);
    const restoredMarketplace = JSON.parse(readFileSync(marketplacePath, 'utf8')) as {
      name: string;
      plugins: Array<{ name: string }>;
    };
    expect(restoredMarketplace).toMatchObject({
      name: 'local', plugins: [{ name: 'existing-plugin' }],
    });
  });

  it('wires the ChatGPT desktop Codex host while leaving hosted Work remote-only', async () => {
    const { aeHome, homeDir, templateDir } = fixture();
    const plan = buildIntegrationPlan({
      channel: 'stable', aeHome, homeDir,
      clients: ['chatgpt-desktop', 'chatgpt-work'],
    });

    expect(plan.clients.find((client) => client.id === 'chatgpt-desktop')).toMatchObject({
      supported: true, localhost: true, verification: 'guided',
    });
    expect(plan.clients.find((client) => client.id === 'chatgpt-work')).toMatchObject({
      supported: false, localhost: false,
    });
    expect(plan.operations.map((operation) => operation.path)).not.toContain(
      join(homeDir, '.codex', 'config.toml'),
    );

    await applyIntegrationPlan(plan, {
      apiKey: 'ae_live_desktop_secret', apiUrl: 'http://127.0.0.1:5050', templateDir,
      runCommand: vi.fn(async () => ({ stdout: '', stderr: '' })),
      dockerCommand,
    });
    const manifest = readFileSync(join(
      homeDir, '.agents', 'plugins', 'plugins', 'answer-engine', '.codex-plugin', 'plugin.json',
    ), 'utf8');
    expect(manifest).toContain('docker');
    expect(manifest).not.toContain('ae_live_desktop_secret');
  });

  it('removes only managed entries and preserves unrelated config', async () => {
    const { aeHome, homeDir, templateDir } = fixture();
    const cursorConfig = join(homeDir, '.cursor', 'mcp.json');
    mkdirSync(join(homeDir, '.cursor'), { recursive: true });
    writeFileSync(cursorConfig, JSON.stringify({
      mcpServers: {
        notes: { command: 'notes-server' },
        'answer-engine': { command: 'previous-answer-engine', args: ['--read-only'] },
      },
      theme: 'dark',
    }, null, 2));
    const plan = buildIntegrationPlan({
      channel: 'stable', aeHome, homeDir, clients: ['cursor'],
    });
    await applyIntegrationPlan(plan, {
      apiKey: 'ae_live_remove_secret', apiUrl: 'http://127.0.0.1:5050', templateDir,
      runCommand: vi.fn(async () => ({ stdout: '', stderr: '' })),
      dockerCommand,
    });
    const withUserEdit = JSON.parse(readFileSync(cursorConfig, 'utf8')) as Record<string, unknown>;
    withUserEdit.fontSize = 15;
    writeFileSync(cursorConfig, `${JSON.stringify(withUserEdit, null, 2)}\n`);

    const result = await removeManagedIntegrations(aeHome, {
      runCommand: vi.fn(async () => ({ stdout: '', stderr: '' })),
    });
    const restored = JSON.parse(readFileSync(cursorConfig, 'utf8')) as {
      mcpServers: Record<string, unknown>; theme: string; fontSize: number;
    };

    expect(result.preserved).toContain(cursorConfig);
    expect(restored.mcpServers).toEqual({
      notes: { command: 'notes-server' },
      'answer-engine': { command: 'previous-answer-engine', args: ['--read-only'] },
    });
    expect(restored).toMatchObject({ theme: 'dark', fontSize: 15 });
    expect(existsSync(join(aeHome, 'integrations', 'ledger.json'))).toBe(false);
  });

  it('invalidates completion when a managed integration path drifts', async () => {
    const { aeHome, homeDir, templateDir } = fixture();
    const plan = buildIntegrationPlan({
      channel: 'stable', aeHome, homeDir, clients: ['cursor'],
    });
    await applyIntegrationPlan(plan, {
      apiKey: 'ae_live_integrity_secret', apiUrl: 'http://127.0.0.1:5050', templateDir,
      runCommand: vi.fn(async () => ({ stdout: '', stderr: '' })),
      dockerCommand,
    });
    expect(integrationLedgerIsCurrent(aeHome)).toBe(true);

    writeFileSync(join(homeDir, '.cursor', 'mcp.json'), '{"mcpServers":{}}\n');

    expect(integrationLedgerIsCurrent(aeHome)).toBe(false);
  });

  it('does not trust a ledger receipt for externally managed plugin registration', async () => {
    const { aeHome, homeDir, templateDir } = fixture();
    const plan = buildIntegrationPlan({
      channel: 'stable', aeHome, homeDir, clients: ['codex'],
    });
    await applyIntegrationPlan(plan, {
      apiKey: 'ae_live_registry_secret', apiUrl: 'http://127.0.0.1:5050', templateDir,
      runCommand: vi.fn(async () => ({ stdout: '', stderr: '' })),
      dockerCommand,
    });

    expect(integrationLedgerIsCurrent(aeHome)).toBe(false);
  });

  it('rejects global integration writes from staging', () => {
    const { aeHome, homeDir } = fixture();
    expect(() => buildIntegrationPlan({
      channel: 'staging', aeHome, homeDir, clients: ['codex'],
    })).toThrow(/staging cannot write global client integrations/i);
  });

  it('does not write Linux-home integrations for Windows desktop clients from WSL2', () => {
    const { aeHome, homeDir } = fixture();
    const plan = buildIntegrationPlan({
      channel: 'stable', aeHome, homeDir, clients: ['chatgpt-desktop', 'claude-desktop'],
      runningInWsl: true,
    });

    expect(plan.operations).toEqual([]);
    expect(plan.clients.every((client) => !client.supported && !client.localhost)).toBe(true);
    expect(plan.clients.map((client) => client.limitation).join(' ')).toMatch(/windows host/i);
  });

  it('keeps removal idempotent when a host plugin was already removed', async () => {
    const { aeHome, homeDir, templateDir } = fixture();
    const plan = buildIntegrationPlan({
      channel: 'stable', aeHome, homeDir, clients: ['codex'],
    });
    await applyIntegrationPlan(plan, {
      apiKey: 'ae_live_remove_secret', apiUrl: 'http://127.0.0.1:5050', templateDir,
      runCommand: vi.fn(async () => ({ stdout: '', stderr: '' })),
      dockerCommand,
    });

    await expect(removeManagedIntegrations(aeHome, {
      runCommand: vi.fn(async () => { throw new Error('plugin is not installed'); }),
    })).resolves.toMatchObject({
      removed: expect.arrayContaining([join(homeDir, '.codex', 'config.toml')]),
    });
    expect(existsSync(join(aeHome, 'integrations'))).toBe(false);
  });

  it('resolves an absolute Docker path for GUI-launched MCP clients', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ae-docker-bin-'));
    tempDirs.push(directory);
    const executable = join(directory, 'docker');
    writeFileSync(executable, 'fixture');

    expect(resolveDockerExecutable({ PATH: directory }, 'darwin')).toBe(executable);
    expect(() => resolveDockerExecutable({ PATH: '' }, 'linux')).toThrow(/could not be resolved/i);
  });
});
