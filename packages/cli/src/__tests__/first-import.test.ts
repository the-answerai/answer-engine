import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  discoverFirstImportSources,
  mergeApprovedHistorySources,
  readFirstImportManifest,
} from '../sync/first-import.js';
import type { TranscriptSource } from '../sync/types.js';
import { claudeCodeSource } from '../sync/sources/claude-code.js';

const tempDirs: string[] = [];
const originalAeHome = process.env.AE_HOME;
const claudeFixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'claude-code',
);
function tempDir(): string {
  const path = mkdtempSync(join(tmpdir(), 'ae-first-import-'));
  tempDirs.push(path);
  return path;
}
afterEach(() => {
  vi.restoreAllMocks();
  if (originalAeHome === undefined) delete process.env.AE_HOME;
  else process.env.AE_HOME = originalAeHome;
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('first import discovery', () => {
  it('inventories path and stat metadata without reading transcript bodies', async () => {
    const readConversations = vi.fn();
    const adapter: TranscriptSource = {
      id: 'codex', label: 'Codex', readConversations,
      discover: vi.fn().mockResolvedValue([{
        sourceId: 'codex', path: '/Users/local/.codex/sessions/rollout.jsonl',
        identity: '1:2', size: 240, mtimeMs: Date.parse('2026-08-14T12:00:00.000Z'),
        inventoryFiles: [
          { path: '/Users/local/.codex/sessions/rollout.jsonl', identity: '1:2', size: 240, mtimeMs: Date.parse('2026-08-14T12:00:00.000Z') },
          { path: '/Users/local/.codex/sessions/sidecar.json', identity: '1:3', size: 60, mtimeMs: Date.parse('2026-08-14T12:01:00.000Z') },
        ],
      }]),
    };

    const sources = await discoverFirstImportSources([adapter]);

    expect(sources[0]).toMatchObject({
      sourceId: 'codex',
      estimatedCount: 1,
      estimatedBytes: 300,
      paths: ['/Users/local/.codex/sessions'],
    });
    expect(sources[0]?.items[0]?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(adapter.discover).toHaveBeenCalledWith({ inventoryOnly: true });
    expect(readConversations).not.toHaveBeenCalled();
  });

  it('keeps inaccessible source discovery safe and source-specific', async () => {
    const adapter: TranscriptSource = {
      id: 'codex', label: 'Codex',
      discover: vi.fn().mockRejectedValue(new Error('private transcript contents')),
    };

    const sources = await discoverFirstImportSources([adapter]);

    expect(sources[0]).toMatchObject({
      sourceId: 'codex',
      availability: 'unavailable',
      estimatedCount: 0,
      availabilityNote: expect.stringContaining('Check local file permissions'),
    });
    expect(sources[0]?.availabilityNote).not.toContain('private transcript contents');
  });

  it('includes every Claude Code bundle file in the consent size and fingerprint', async () => {
    const root = join(tempDir(), 'claude-project');
    cpSync(claudeFixtureDir, root, { recursive: true });
    const adapter: TranscriptSource = {
      ...claudeCodeSource,
      discover: (options) => claudeCodeSource.discover({ ...options, paths: [root] }),
    };

    const [source] = await discoverFirstImportSources([adapter]);
    const [file] = await adapter.discover({ inventoryOnly: true });

    expect(file?.inventoryFiles?.some((entry) => entry.path.includes('/subagents/'))).toBe(true);
    expect(source?.estimatedBytes).toBe(
      file?.inventoryFiles?.reduce((total, entry) => total + entry.size, 0),
    );
    expect(source?.estimatedBytes).toBeGreaterThan(file?.size ?? Number.POSITIVE_INFINITY);
  });

  it('refuses to read a server-selected manifest outside the runtime home', () => {
    const root = tempDir();
    const outside = join(root, 'fabricated.json');
    process.env.AE_HOME = join(root, 'home');
    mkdirSync(join(process.env.AE_HOME, 'data', 'first-import'), { recursive: true });
    writeFileSync(outside, JSON.stringify({ version: 1, sessionId: crypto.randomUUID(), sources: [] }));

    expect(() => readFirstImportManifest(outside)).toThrow(
      'The local first-import discovery manifest is missing, unsafe, or invalid',
    );
  });

  it('atomically merges approved transcript sources without losing unrelated configuration', () => {
    const root = tempDir();
    const path = join(root, 'config.yaml');
    mkdirSync(root, { recursive: true });
    writeFileSync(path, `models:\n  chat: local-chat\n  embedding: local-embed\n  chat_provider: lmstudio\n  embedding_provider: lmstudio\n  embedding_dimension: 768\nsources:\n  - type: local_dir\n    path: /Users/local/Notes\n    include: ["**/*.md"]\nconnectors: {}\nserver:\n  port: 5050\n  bind: 127.0.0.1\n`);

    mergeApprovedHistorySources(path, ['codex', 'claude-code']);
    const merged = parseYaml(readFileSync(path, 'utf8')) as { sources: Array<Record<string, unknown>>; server: { port: number } };

    expect(merged.sources).toEqual([
      expect.objectContaining({ type: 'local_dir', path: '/Users/local/Notes' }),
      { type: 'codex' },
      { type: 'claude-code' },
    ]);
    expect(merged.server.port).toBe(5050);
  });
});
