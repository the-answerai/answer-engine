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
  readIntegrationLedger,
  removeManagedIntegrations,
} from '../integrations.js';

const tempDirs: string[] = [];

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
        command: 'npx', args: ['-y', '@answer-engine/mcp-server@1.1.0'],
        env: {
          ANSWER_ENGINE_API_KEY: '__ANSWER_ENGINE_API_KEY__',
          ANSWER_ENGINE_API_URL: '__ANSWER_ENGINE_API_URL__',
        },
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
      join(homeDir, '.codex', 'config.toml'),
      join(homeDir, '.agents', 'plugins', 'marketplace.json'),
      join(homeDir, '.agents', 'plugins', 'plugins', 'answer-engine'),
      join(homeDir, '.claude.json'),
      join(homeDir, '.claude', 'skills', 'answer-engine'),
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
    mkdirSync(join(homeDir, '.codex'), { recursive: true });
    writeFileSync(codexConfig, '[mcp_servers.filesystem]\ncommand = "node"\nargs = ["fs.js"]\n');
    const plan = buildIntegrationPlan({
      channel: 'stable', aeHome, homeDir, clients: ['codex', 'claude-code'],
    });
    const runCommand = vi.fn(async () => ({ stdout: '{"installed":true}', stderr: '' }));

    const first = await applyIntegrationPlan(plan, {
      apiKey: 'ae_live_super_secret_key', apiUrl: 'http://127.0.0.1:5050', templateDir, runCommand,
    });
    const firstBytes = new Map(plan.operations
      .filter((operation) => operation.kind !== 'plugin-command')
      .map((operation) => [operation.path, existsSync(operation.path) && statSync(operation.path).isFile()
        ? readFileSync(operation.path) : undefined]));
    const second = await applyIntegrationPlan(plan, {
      apiKey: 'ae_live_super_secret_key', apiUrl: 'http://127.0.0.1:5050', templateDir, runCommand,
    });

    expect(first.changed).toBeGreaterThan(0);
    expect(second.changed).toBe(0);
    for (const [path, bytes] of firstBytes) {
      if (bytes) expect(readFileSync(path)).toEqual(bytes);
    }
    expect(readFileSync(codexConfig, 'utf8')).toContain('[mcp_servers.filesystem]');
    const cliConfig = parseYaml(readFileSync(join(homeDir, '.config', 'answer-engine', 'config.yml'), 'utf8')) as Record<string, unknown>;
    expect(cliConfig).toMatchObject({
      api_key: 'ae_live_super_secret_key', api_url: 'http://127.0.0.1:5050',
    });
    const ledger = readIntegrationLedger(aeHome);
    expect(JSON.stringify(ledger)).not.toContain('ae_live_super_secret_key');
    expect(statSync(join(aeHome, 'integrations', 'ledger.json')).mode & 0o777).toBe(0o600);
    expect(ledger.entries.some((entry) => entry.backupPath)).toBe(true);
    expect(runCommand).toHaveBeenCalledWith('codex', ['plugin', 'add', 'answer-engine@personal', '--json']);
  });

  it('removes only managed entries and preserves unrelated config', async () => {
    const { aeHome, homeDir, templateDir } = fixture();
    const cursorConfig = join(homeDir, '.cursor', 'mcp.json');
    mkdirSync(join(homeDir, '.cursor'), { recursive: true });
    writeFileSync(cursorConfig, JSON.stringify({
      mcpServers: { notes: { command: 'notes-server' } }, theme: 'dark',
    }, null, 2));
    const plan = buildIntegrationPlan({
      channel: 'stable', aeHome, homeDir, clients: ['cursor'],
    });
    await applyIntegrationPlan(plan, {
      apiKey: 'ae_live_remove_secret', apiUrl: 'http://127.0.0.1:5050', templateDir,
      runCommand: vi.fn(async () => ({ stdout: '', stderr: '' })),
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
    expect(restored.mcpServers).toEqual({ notes: { command: 'notes-server' } });
    expect(restored).toMatchObject({ theme: 'dark', fontSize: 15 });
    expect(existsSync(join(aeHome, 'integrations', 'ledger.json'))).toBe(false);
  });

  it('rejects global integration writes from staging', () => {
    const { aeHome, homeDir } = fixture();
    expect(() => buildIntegrationPlan({
      channel: 'staging', aeHome, homeDir, clients: ['codex'],
    })).toThrow(/staging cannot write global client integrations/i);
  });
});
