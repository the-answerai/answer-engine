import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ImportRequest } from '../api-client.js';
import { conversationSearchText } from '../sync/importer.js';
import { normalizeCodexSession } from '../sync/sources/codex-normalize.js';
import { readCodexThreadMetadata } from '../sync/sources/codex-state-db.js';
import { codexSource } from '../sync/sources/codex.js';
import { runSyncOnce } from '../sync/sync-daemon.js';

interface TestStatement {
  run(...parameters: unknown[]): unknown;
}

interface TestDatabase {
  exec(sql: string): void;
  prepare(sql: string): TestStatement;
  close(): void;
}

interface TestSqliteModule {
  DatabaseSync: new (path: string) => TestDatabase;
}

const tempDirs: string[] = [];
const openDatabases = new Set<TestDatabase>();
const originalAeHome = process.env.AE_HOME;
const originalCodexHome = process.env.CODEX_HOME;
const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'codex',
  'rollout-sample.jsonl',
);

function loadTestSqlite(): TestSqliteModule {
  const require = createRequire(import.meta.url);
  return require('node:sqlite') as TestSqliteModule;
}

function makeCodexFixture(options: { archived?: boolean } = {}): {
  codexHome: string;
  rolloutPath: string;
  database: TestDatabase;
} {
  const root = mkdtempSync(join(tmpdir(), 'ae-codex-normalize-'));
  tempDirs.push(root);
  const codexHome = join(root, 'codex-home');
  const rolloutDirectory = options.archived
    ? join(codexHome, 'archived_sessions')
    : join(codexHome, 'sessions', '2026', '08', '10');
  mkdirSync(rolloutDirectory, { recursive: true });
  const rolloutPath = join(rolloutDirectory, 'rollout-sample.jsonl');
  cpSync(fixturePath, rolloutPath);
  process.env.AE_HOME = join(root, 'ae-home');
  process.env.CODEX_HOME = codexHome;

  const { DatabaseSync } = loadTestSqlite();
  const database = new DatabaseSync(join(codexHome, 'state_5.sqlite'));
  database.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
  database.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      title TEXT,
      name TEXT,
      archived INTEGER NOT NULL,
      git_branch TEXT,
      git_origin_url TEXT,
      git_sha TEXT,
      model TEXT,
      reasoning_effort TEXT,
      tokens_used INTEGER,
      cwd TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      has_user_event INTEGER
    );
  `);
  database.prepare(`
    INSERT INTO threads (
      id, rollout_path, title, name, archived, git_branch, git_origin_url,
      git_sha, model, reasoning_effort, tokens_used, cwd, created_at,
      updated_at, has_user_event
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'codex-session-915',
    rolloutPath,
    'SQLite joined title',
    'fixture-thread',
    0,
    'feat/sqlite-branch',
    'https://example.com/fixture.git',
    'abc123',
    'gpt-5.4-fixture',
    'high',
    125,
    '/workspace/from-db',
    1_786_300_800,
    1_786_300_815,
    1,
  );
  openDatabases.add(database);
  expect(existsSync(join(codexHome, 'state_5.sqlite-wal'))).toBe(true);
  return { codexHome, rolloutPath, database };
}

function closeTestDatabase(database: TestDatabase): void {
  if (!openDatabases.delete(database)) return;
  database.close();
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('Codex conversation normalization', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    if (originalAeHome === undefined) delete process.env.AE_HOME;
    else process.env.AE_HOME = originalAeHome;
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    for (const database of openDatabases) closeTestDatabase(database);
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('normalizes canonical messages, linked tools, opaque reasoning, duplicates, and unknown records', async () => {
    const { codexHome, rolloutPath, database } = makeCodexFixture();
    const files = await codexSource.discover();
    expect(files.map((file) => file.path)).toEqual([rolloutPath]);

    const result = await codexSource.readConversations!(files[0]);
    closeTestDatabase(database);

    expect(result.errors).toEqual([]);
    expect(result.processedLines).toBe(18);
    expect(result.conversations).toHaveLength(1);
    const [conversation] = result.conversations;
    expect(conversation.events).toHaveLength(18);
    expect(conversation.events.flatMap((event) => event.content_blocks)).toHaveLength(10);
    expect(conversation).toMatchObject({
      provider: 'openai_codex',
      surface: 'codex',
      source_conversation_id: 'codex-session-915',
      title: 'SQLite joined title',
      cwd: '/workspace/from-db',
      model: 'gpt-5.4-fixture',
      reasoning_effort: 'high',
      archived: false,
      adapter_name: 'codex-history',
      adapter_version: '1.0.0',
    });
    expect(conversation.provider_metadata_json).toMatchObject({
      cwd: '/workspace/from-db',
      session_cwd: '/workspace/fixture',
      title: 'SQLite joined title',
      model: 'gpt-5.4-fixture',
      reasoning_effort: 'high',
      archived: false,
      git_branch: 'feat/sqlite-branch',
      git_origin_url: 'https://example.com/fixture.git',
      tokens_used: 125,
      cli_version: '1.2.3',
    });

    expect(conversation.events.filter((event) => event.category === 'message')).toHaveLength(2);
    expect(conversation.events.find((event) => event.provider_subtype === 'message')?.content_blocks)
      .toEqual([{ ordinal: 0, block_type: 'input_text', text: 'Remember the blue launch checklist.' }]);

    const standardCall = conversation.events.find(
      (event) => event.provider_subtype === 'function_call',
    );
    const standardResult = conversation.events.find(
      (event) => event.provider_subtype === 'function_call_output',
    );
    expect(standardCall).toMatchObject({
      category: 'tool_call',
      content_blocks: [{
        block_type: 'tool_use',
        tool_call_id: 'call-standard',
        tool_name: 'exec_command',
      }],
    });
    expect(standardResult).toMatchObject({
      category: 'tool_result',
      content_blocks: [{ block_type: 'tool_result', tool_call_id: 'call-standard' }],
    });
    expect(conversation.events.find((event) => event.provider_subtype === 'custom_tool_call'))
      .toMatchObject({ content_blocks: [{ tool_call_id: 'call-custom' }] });
    expect(conversation.events.find((event) => event.provider_subtype === 'custom_tool_call_output'))
      .toMatchObject({ content_blocks: [{ tool_call_id: 'call-custom' }] });
    expect(conversation.events.find((event) => event.provider_subtype === 'web_search_call'))
      .toMatchObject({
        category: 'tool_call',
        content_blocks: [{ block_type: 'tool_use', tool_call_id: 'web-item-1', tool_name: 'web_search' }],
      });

    const reasoning = conversation.events.find((event) => event.category === 'reasoning');
    expect(reasoning).toMatchObject({
      role: 'assistant',
      content_blocks: [{
        block_type: 'encrypted',
        json_payload: {
          encrypted_content: 'gAAAAA-fixture-encrypted-reasoning',
          summary: [{ type: 'summary_text', text: 'opaque summary wrapper' }],
          content: null,
        },
      }],
    });

    expect(conversation.events.find((event) => event.provider_type === 'turn_context')?.category)
      .toBe('state');
    expect(conversation.events.find((event) => event.provider_type === 'world_state')?.category)
      .toBe('state');
    expect(conversation.events.find((event) => event.provider_type === 'compacted')?.category)
      .toBe('compaction');
    expect(conversation.events.find(
      (event) => event.provider_type === 'inter_agent_communication_metadata',
    )?.category).toBe('lifecycle');
    expect(conversation.events.find((event) => event.provider_type === 'future_envelope'))
      .toMatchObject({
        category: 'lifecycle',
        content_blocks: [{ block_type: 'opaque', json_payload: [{ future_value: 42 }] }],
      });
    expect(conversation.events.find((event) => event.provider_subtype === 'future_response_item'))
      .toMatchObject({ category: 'lifecycle', content_blocks: [{ block_type: 'opaque' }] });

    const duplicateEvents = conversation.events.filter((event) => (
      event.provider_subtype === 'user_message' || event.provider_subtype === 'agent_message'
    ));
    expect(duplicateEvents).toHaveLength(2);
    expect(duplicateEvents.every((event) => event.category === 'lifecycle')).toBe(true);
    expect(duplicateEvents.every((event) => event.content_blocks.length === 0)).toBe(true);
    expect(conversation.relations.filter((relation) => relation.relation_type === 'duplicate_of'))
      .toHaveLength(2);

    const searchText = conversationSearchText(conversation) ?? '';
    expect(countOccurrences(searchText, 'Remember the blue launch checklist.')).toBe(1);
    expect(countOccurrences(searchText, 'I will remember the blue launch checklist.')).toBe(1);
    expect(searchText).not.toContain('gAAAAA-fixture-encrypted-reasoning');
    expect(searchText).not.toContain('future_protocol');
    expect(searchText).not.toContain('future_value');

    const archiveRoot = join(codexHome, '..', 'ae-home', 'raw-archive');
    const [archiveName] = readdirSync(archiveRoot);
    const manifest = JSON.parse(
      readFileSync(join(archiveRoot, archiveName, 'manifest.json'), 'utf8'),
    ) as {
      adapter_name: string;
      files: Array<{ path: string; archive_path: string; sha256: string }>;
    };
    const expectedHash = createHash('sha256').update(readFileSync(rolloutPath)).digest('hex');
    expect(manifest).toMatchObject({
      adapter_name: 'codex-history',
      files: [{ path: rolloutPath, sha256: expectedHash }],
    });
    expect(conversation.source_sha256).toBe(expectedHash);
    expect(result.sourceFingerprint).toBe(expectedHash);
    expect(readFileSync(join(archiveRoot, archiveName, manifest.files[0].archive_path)))
      .toEqual(readFileSync(rolloutPath));
  });

  it('reads WAL-backed thread metadata and verifies archive location against the DB', async () => {
    const { codexHome, rolloutPath, database } = makeCodexFixture({ archived: true });
    const metadata = await readCodexThreadMetadata(join(codexHome, 'state_5.sqlite'));
    expect(metadata.get('codex-session-915')).toMatchObject({
      rollout_path: rolloutPath,
      title: 'SQLite joined title',
      archived: false,
      git_branch: 'feat/sqlite-branch',
      tokens_used: 125,
      has_user_event: true,
    });
    expect(metadata.get(rolloutPath)).toEqual(metadata.get('codex-session-915'));

    const [file] = await codexSource.discover();
    const result = await codexSource.readConversations!(file);
    closeTestDatabase(database);
    expect(result.conversations[0].archived).toBe(true);
    expect(result.conversations[0].provider_metadata_json).toMatchObject({
      archive_state_mismatch: {
        directory_archived: true,
        database_archived: false,
      },
    });
  });

  it('returns no metadata when state_5.sqlite is absent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ae-codex-no-db-'));
    tempDirs.push(root);
    await expect(readCodexThreadMetadata(join(root, 'state_5.sqlite')))
      .resolves.toEqual(new Map());
  });

  it('keeps session_meta identity when the thread ID disagrees and falls back to session_id', () => {
    const [conversation] = normalizeCodexSession({
      records: [{
        line: 1,
        value: {
          timestamp: '2026-08-10T20:00:00.000Z',
          type: 'session_meta',
          payload: {
            session_id: 'session-id-fallback',
            timestamp: '2026-08-10T20:00:00.000Z',
          },
        },
      }],
      path: '/tmp/rollout-id-fallback.jsonl',
      sha256: 'a'.repeat(64),
      fallbackTimestamp: '2026-08-10T20:00:00.000Z',
      threadMeta: { id: 'different-thread-id', archived: false },
      archived: false,
    });

    expect(conversation.source_conversation_id).toBe('session-id-fallback');
    expect(conversation.provider_metadata_json).toMatchObject({
      session_meta_session_id: 'session-id-fallback',
      thread_id_mismatch: {
        session_id: 'session-id-fallback',
        thread_id: 'different-thread-id',
      },
    });
  });

  it('reports complete malformed records, ignores an incomplete tail, and retains line sequences', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ae-codex-live-'));
    tempDirs.push(root);
    const rolloutDirectory = join(root, 'sessions', '2026', '08', '10');
    mkdirSync(rolloutDirectory, { recursive: true });
    const rolloutPath = join(rolloutDirectory, 'rollout-live.jsonl');
    process.env.CODEX_HOME = root;
    process.env.AE_HOME = join(root, 'ae-home');
    const sessionMeta = JSON.stringify({
      timestamp: '2026-08-10T20:00:00.000Z',
      type: 'session_meta',
      payload: { id: 'live-session', timestamp: '2026-08-10T20:00:00.000Z' },
    });
    const message = JSON.stringify({
      timestamp: '2026-08-10T20:00:03.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Complete after errors' }],
      },
    });
    writeFileSync(
      rolloutPath,
      `${sessionMeta}\n{malformed}\n42\n${message}\n{"timestamp":`,
      'utf8',
    );

    const [file] = await codexSource.discover({ paths: [rolloutPath] });
    const result = await codexSource.readConversations!(file);

    expect(result.processedLines).toBe(4);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toMatchObject({ filePath: rolloutPath, line: 2 });
    expect(result.errors[1]).toEqual({
      filePath: rolloutPath,
      line: 3,
      message: 'JSONL record is not an object',
    });
    expect(result.conversations[0].events.map((event) => event.sequence)).toEqual([0, 3]);
  });

  it('never discovers prompt history, indexes, worktrees, or unrelated stores', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ae-codex-discovery-'));
    tempDirs.push(root);
    process.env.CODEX_HOME = root;
    const excluded = [
      join(root, 'history.jsonl'),
      join(root, 'session_index.jsonl'),
      join(root, 'worktrees', 'project', 'rollout.jsonl'),
      join(root, 'logs', 'events.jsonl'),
    ];
    for (const path of excluded) {
      mkdirSync(dirname(path), { recursive: true });
      cpSync(fixturePath, path);
    }
    expect(await codexSource.discover()).toEqual([]);
    expect(await codexSource.discover({ paths: excluded })).toEqual([]);
  });

  it('imports once and skips an unchanged rollout by SHA-256 fingerprint', async () => {
    const { codexHome, rolloutPath, database } = makeCodexFixture();
    const cursorFile = join(codexHome, 'cursor.json');
    const requests: ImportRequest[] = [];
    const client = {
      submitSyncImport: vi.fn((request: ImportRequest) => {
        requests.push(request);
        return Promise.resolve({
          success: true as const,
          data: {
            totalItems: request.items.length,
            completedItems: request.items.length,
            failedItems: 0,
            contentIds: ['content-codex'],
            failures: [],
          },
        });
      }),
    };
    const options = {
      sourceId: 'codex' as const,
      paths: [rolloutPath],
      cursorFile,
      batchSize: 1,
      client,
    };

    const first = await runSyncOnce(options);
    const second = await runSyncOnce(options);
    closeTestDatabase(database);

    expect(first).toMatchObject({ filesScanned: 1, turnsFound: 1, turnsImported: 1 });
    expect(second).toMatchObject({ filesScanned: 1, turnsFound: 0, turnsImported: 0 });
    expect(client.submitSyncImport).toHaveBeenCalledTimes(1);
    expect(requests[0].items).toHaveLength(1);
    expect(requests[0].items[0]).toMatchObject({
      source: 'codex',
      source_agent_id: 'codex',
      source_identifier: 'openai_codex:codex:codex-session-915',
      'metadata.sync.adapter_name': 'codex-history',
    });
    expect(readdirSync(join(codexHome, '..', 'ae-home', 'raw-archive'))).toHaveLength(1);
  });
});
