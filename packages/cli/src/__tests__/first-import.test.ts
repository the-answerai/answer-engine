import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  discoverFirstImportSources,
  mergeApprovedHistorySources,
} from '../sync/first-import.js';
import type { TranscriptSource } from '../sync/types.js';

const tempDirs: string[] = [];
function tempDir(): string {
  const path = mkdtempSync(join(tmpdir(), 'ae-first-import-'));
  tempDirs.push(path);
  return path;
}
afterEach(() => {
  vi.restoreAllMocks();
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
      }]),
    };

    const sources = await discoverFirstImportSources([adapter]);

    expect(sources[0]).toMatchObject({ sourceId: 'codex', estimatedCount: 1, estimatedBytes: 240 });
    expect(sources[0]?.items[0]?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(adapter.discover).toHaveBeenCalledWith({ inventoryOnly: true });
    expect(readConversations).not.toHaveBeenCalled();
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
