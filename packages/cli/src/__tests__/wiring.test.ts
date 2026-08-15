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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FILE_WIRING_CLIENTS,
  buildMcpEntry,
  detectInstalledClients,
  renderClaudeCodeCommand,
  renderHttpConnection,
  resolveClientConfigPath,
  unwireClient,
  wireClient,
} from '../wiring/index.js';
import type { FileWiringClient, WiringInput } from '../wiring/index.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'wiring');
const tempDirs: string[] = [];

const baseInput = {
  apiKey: 'ae_test_key',
  serverUrl: 'http://localhost:5050/',
  library: 'personal-memory',
} as const;

const existingFixtureByClient: Record<FileWiringClient, string> = {
  'claude-code': 'claude-code.existing.json',
  codex: 'codex.existing.toml',
  cursor: 'cursor.existing.json',
  'claude-desktop': 'claude-desktop.existing.json',
};

const preservedTextByClient: Record<FileWiringClient, string> = {
  'claude-code': '"filesystem": { "command": "node", "args": ["filesystem.js"] }',
  codex: '[mcp_servers.filesystem]\ncommand = "node"\nargs = [ "filesystem.js" ]',
  cursor: '"browser-tools": {\n      "command": "bunx",\n      "args": [\n        "browser-tools-mcp"\n      ]\n    }',
  'claude-desktop': '"notes": { "command": "/opt/notes/server", "args": [] }',
};

function createTempPath(filename: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ae-wiring-'));
  tempDirs.push(dir);
  return join(dir, filename);
}

function inputFor(client: FileWiringClient): WiringInput & { client: FileWiringClient } {
  return { client, ...baseInput };
}

function parseWritten(client: FileWiringClient, contents: string): Record<string, unknown> {
  return client === 'codex'
    ? parseToml(contents) as Record<string, unknown>
    : JSON.parse(contents) as Record<string, unknown>;
}

function answerEngineEntry(parsed: Record<string, unknown>): Record<string, unknown> {
  const servers = (parsed.mcpServers ?? parsed.mcp_servers) as Record<string, unknown>;
  return servers['answer-engine'] as Record<string, unknown>;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('agent wiring config writers', () => {
  for (const client of FILE_WIRING_CLIENTS) {
    it(`creates a valid fresh ${client} config with owner-only permissions`, () => {
      const extension = client === 'codex' ? 'toml' : 'json';
      const path = createTempPath(`nested/config.${extension}`);

      const result = wireClient(inputFor(client), { path });

      const contents = readFileSync(path, 'utf8');
      const entry = answerEngineEntry(parseWritten(client, contents));
      expect(entry).toEqual(buildMcpEntry(inputFor(client)));
      expect(result).toEqual({ path, created: true });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(existsSync(`${path}.bak`)).toBe(false);
    });

    it(`merges ${client} without changing unrelated server bytes and backs up first`, () => {
      const fixture = readFileSync(join(fixturesDir, existingFixtureByClient[client]), 'utf8');
      const extension = client === 'codex' ? 'toml' : 'json';
      const path = createTempPath(`config.${extension}`);
      writeFileSync(path, fixture, { encoding: 'utf8', mode: 0o644 });

      const result = wireClient(inputFor(client), { path });

      const contents = readFileSync(path, 'utf8');
      expect(contents).toContain(preservedTextByClient[client]);
      expect(answerEngineEntry(parseWritten(client, contents))).toEqual(buildMcpEntry(inputFor(client)));
      expect(readFileSync(`${path}.bak`, 'utf8')).toBe(fixture);
      expect(result).toEqual({ path, backupPath: `${path}.bak`, created: false });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(`${path}.bak`).mode & 0o777).toBe(0o600);
    });
  }

  for (const client of FILE_WIRING_CLIENTS) {
    it(`removes only the managed ${client} MCP entry`, () => {
      const fixture = readFileSync(join(fixturesDir, existingFixtureByClient[client]), 'utf8');
      const extension = client === 'codex' ? 'toml' : 'json';
      const path = createTempPath(`remove.${extension}`);
      writeFileSync(path, fixture, { encoding: 'utf8', mode: 0o600 });
      wireClient(inputFor(client), { path, backup: false });

      unwireClient(client, { path, backup: false });

      const contents = readFileSync(path, 'utf8');
      expect(contents).toContain(preservedTextByClient[client]);
      expect(contents).not.toContain('answer-engine');
      expect(existsSync(`${path}.bak`)).toBe(false);
      parseWritten(client, contents);
    });
  }

  for (const client of FILE_WIRING_CLIENTS) {
    it(`re-wiring a fresh ${client} config is a byte-stable no-op`, () => {
      const extension = client === 'codex' ? 'toml' : 'json';
      const path = createTempPath(`config.${extension}`);
      wireClient(inputFor(client), { path });
      const first = readFileSync(path, 'utf8');

      const result = wireClient(inputFor(client), { path });

      expect(readFileSync(path, 'utf8')).toBe(first);
      expect(result).toEqual({ path, created: false });
      expect(existsSync(`${path}.bak`)).toBe(false);
    });
  }

  it('is idempotent and leaves malformed input untouched', () => {
    const path = createTempPath('mcp.json');
    wireClient(inputFor('cursor'), { path });
    const first = readFileSync(path, 'utf8');

    wireClient(inputFor('cursor'), { path });

    expect(readFileSync(path, 'utf8')).toBe(first);
    writeFileSync(path, '{ invalid json', 'utf8');
    expect(() => wireClient(inputFor('cursor'), { path })).toThrow(/Invalid JSON/);
    expect(readFileSync(path, 'utf8')).toBe('{ invalid json');
  });

  it('upgrades an existing empty JSON file and leaves malformed TOML untouched', () => {
    const jsonPath = createTempPath('empty.json');
    writeFileSync(jsonPath, '  \n', 'utf8');

    const result = wireClient(inputFor('cursor'), { path: jsonPath });

    expect(answerEngineEntry(JSON.parse(readFileSync(jsonPath, 'utf8')) as Record<string, unknown>))
      .toEqual(buildMcpEntry(inputFor('cursor')));
    expect(readFileSync(`${jsonPath}.bak`, 'utf8')).toBe('  \n');
    expect(result.created).toBe(false);

    const tomlPath = createTempPath('invalid.toml');
    writeFileSync(tomlPath, '[invalid', 'utf8');
    expect(() => wireClient(inputFor('codex'), { path: tomlPath })).toThrow(/Invalid Codex TOML/);
    expect(readFileSync(tomlPath, 'utf8')).toBe('[invalid');
    expect(existsSync(`${tomlPath}.bak`)).toBe(false);
  });
});

describe('agent wiring renderers', () => {
  it('builds the canonical stdio entry and omits an unspecified library', () => {
    expect(buildMcpEntry({
      client: 'claude-code',
      apiKey: 'key',
      serverUrl: 'https://example.test',
    })).toEqual({
      command: 'npx',
      args: ['-y', '@answer-engine/mcp-server@1.1.0'],
      env: {
        ANSWER_ENGINE_API_KEY: 'key',
        ANSWER_ENGINE_API_URL: 'https://example.test',
      },
    });
  });

  it('renders a shell-safe Claude Code command', () => {
    expect(renderClaudeCodeCommand({
      client: 'claude-code',
      apiKey: 'key with spaces',
      serverUrl: 'http://localhost:5050',
      library: "agent's memory",
    })).toBe(
      "claude mcp add answer-engine --env 'ANSWER_ENGINE_API_KEY=key with spaces' --env ANSWER_ENGINE_API_URL=http://localhost:5050 --env 'ANSWER_ENGINE_LIBRARY=agent'\"'\"'s memory' -- npx -y @answer-engine/mcp-server@1.1.0",
    );
  });

  it('renders normalized StreamableHTTP text and JSON', () => {
    const result = renderHttpConnection({
      client: 'http',
      apiKey: 'ae_http_key',
      serverUrl: 'https://api.example.test/',
    });

    expect(result.url).toBe('https://api.example.test/mcp');
    expect(result.text).toContain('X-API-Key: ae_http_key');
    expect(result.text).toContain('Authorization: Bearer ae_http_key');
    expect(JSON.parse(result.json)).toEqual({
      mcpServers: {
        'answer-engine': {
          url: 'https://api.example.test/mcp',
          headers: { 'X-API-Key': 'ae_http_key' },
        },
      },
    });
  });
});

describe('agent wiring paths and detection', () => {
  it('resolves each platform path and prefers a project Cursor directory', () => {
    const homeDir = createTempPath('home');
    const cwd = createTempPath('project');
    mkdirSync(join(cwd, '.cursor'), { recursive: true });

    expect(resolveClientConfigPath('claude-code', { homeDir, cwd })).toBe(join(homeDir, '.claude.json'));
    expect(resolveClientConfigPath('codex', { homeDir, cwd })).toBe(join(homeDir, '.codex', 'config.toml'));
    expect(resolveClientConfigPath('cursor', { homeDir, cwd })).toBe(join(cwd, '.cursor', 'mcp.json'));
    expect(resolveClientConfigPath('claude-desktop', { homeDir, cwd, platform: 'darwin' })).toBe(
      join(homeDir, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    );
    expect(resolveClientConfigPath('claude-desktop', { homeDir, cwd, platform: 'linux' })).toBe(
      join(homeDir, '.config', 'Claude', 'claude_desktop_config.json'),
    );
    expect(resolveClientConfigPath('claude-desktop', {
      homeDir,
      cwd,
      platform: 'win32',
      appData: join(homeDir, 'Roaming'),
    })).toBe(join(homeDir, 'Roaming', 'Claude', 'claude_desktop_config.json'));
  });

  it('detects existing client config directories and supports force-all', () => {
    const homeDir = createTempPath('home');
    const cwd = createTempPath('project');
    mkdirSync(join(homeDir, '.codex'), { recursive: true });
    mkdirSync(join(cwd, '.cursor'), { recursive: true });

    expect(detectInstalledClients({ homeDir, cwd, platform: 'linux' })).toEqual(['codex', 'cursor']);
    expect(detectInstalledClients({ homeDir, cwd, platform: 'linux', forceAll: true })).toEqual(
      FILE_WIRING_CLIENTS,
    );
  });
});
