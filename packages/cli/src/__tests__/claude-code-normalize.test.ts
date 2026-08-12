import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeCodeSource } from '../sync/sources/claude-code.js';

const tempDirs: string[] = [];
const originalAeHome = process.env.AE_HOME;
const fixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'claude-code',
);

function makeFixtureCopy(): { root: string; sessionPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'ae-claude-normalize-'));
  tempDirs.push(root);
  cpSync(fixtureDir, root, { recursive: true });
  process.env.AE_HOME = join(root, 'ae-home');
  return { root, sessionPath: join(root, 'session-tree.jsonl') };
}

describe('Claude Code conversation normalization', () => {
  afterEach(() => {
    if (originalAeHome === undefined) delete process.env.AE_HOME;
    else process.env.AE_HOME = originalAeHome;
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('preserves trees and sidechains while importing subagents separately', async () => {
    const { root, sessionPath } = makeFixtureCopy();
    const files = await claudeCodeSource.discover({ paths: [root] });

    expect(files.map((file) => file.path)).toEqual([sessionPath]);
    expect(claudeCodeSource.readConversations).toBeTypeOf('function');

    const result = await claudeCodeSource.readConversations!(files[0]);

    expect(result.errors).toEqual([]);
    expect(result.conversations).toHaveLength(2);

    const parent = result.conversations.find(
      (conversation) => conversation.source_conversation_id === 'session-tree',
    );
    const child = result.conversations.find(
      (conversation) => conversation.parent_source_conversation_id === 'session-tree',
    );

    expect(parent).toBeDefined();
    expect(child).toBeDefined();
    expect(parent?.title).toBe('Pinned project title');
    expect(parent?.cwd).toBe('/workspace/project');
    expect(parent?.model).toBe('claude-opus-test');
    expect(parent?.provider_metadata_json).toMatchObject({
      gitBranch: 'feat/tree',
      version: '2.1.0',
      requestId: 'request-1',
      usage: { input_tokens: 10, output_tokens: 20 },
    });

    expect(parent?.events.slice(0, -1).map((event) => event.source_event_id)).toEqual([
      'u-root',
      'a-main',
      'tool-result-1',
      'u-branch',
      'a-side',
      'title-ai',
      'title-custom',
      'title-ai-late',
      'compact-1',
      'system-stop',
      'system-error',
      'system-info',
      'system-refusal',
      'system-command',
      'attachment-1',
      'mode-1',
      'pr-link-1',
      'frame-link-1',
      'queue-1',
    ]);
    expect(parent?.events.at(-1)?.source_event_id).toMatch(/^[a-f0-9]{64}$/);
    expect(parent?.events.find((event) => event.source_event_id === 'u-branch')).toMatchObject({
      sequence: 3,
      parent_event_id: 'a-main',
    });
    expect(parent?.events.find((event) => event.source_event_id === 'a-side')).toMatchObject({
      sequence: 4,
      parent_event_id: 'u-root',
    });
    expect(parent?.relations).toContainEqual({
      relation_type: 'sidechain',
      source_event_id: 'a-side',
      target_source_event_id: 'u-root',
    });

    const assistant = parent?.events.find((event) => event.source_event_id === 'a-main');
    expect(assistant?.content_blocks).toEqual([
      { ordinal: 0, block_type: 'text', text: 'I will inspect it.' },
      {
        ordinal: 1,
        block_type: 'thinking',
        text: 'Need a focused investigation.',
        json_payload: { signature: 'signed-thinking' },
      },
      {
        ordinal: 2,
        block_type: 'tool_use',
        tool_call_id: 'spawn-tool',
        tool_name: 'Task',
        json_payload: { subagent_type: 'researcher' },
      },
    ]);

    expect(parent?.events.find((event) => event.source_event_id === 'tool-result-1')).toMatchObject({
      category: 'tool_result',
      role: 'tool',
      content_blocks: [{
        ordinal: 0,
        block_type: 'tool_result',
        tool_call_id: 'spawn-tool',
        text: 'Research complete',
        is_error: false,
      }],
    });
    expect(parent?.events.find((event) => event.source_event_id === 'compact-1')).toMatchObject({
      category: 'compaction',
      role: 'system',
      provider_subtype: 'compact_boundary',
    });
    expect(parent?.events.find((event) => event.source_event_id === 'attachment-1')).toMatchObject({
      category: 'attachment',
      provider_type: 'attachment',
    });
    expect(parent?.events.find((event) => event.source_event_id === 'mode-1')).toMatchObject({
      category: 'state',
      provider_type: 'mode',
      provider_subtype: 'plan',
    });
    for (const [sourceEventId, subtype] of [
      ['system-stop', 'stop_hook_summary'],
      ['system-error', 'api_error'],
      ['system-info', 'informational'],
      ['system-refusal', 'model_refusal_fallback'],
      ['system-command', 'local_command'],
    ]) {
      expect(parent?.events.find((event) => event.source_event_id === sourceEventId)).toMatchObject({
        category: 'system',
        provider_type: 'system',
        provider_subtype: subtype,
      });
    }
    expect(parent?.events.filter((event) => [
      'pr-link',
      'frame-link',
      'queue-operation',
      'last-prompt',
    ].includes(event.provider_type))).toEqual([
      expect.objectContaining({ category: 'lifecycle', provider_type: 'pr-link' }),
      expect.objectContaining({ category: 'lifecycle', provider_type: 'frame-link' }),
      expect.objectContaining({
        category: 'lifecycle',
        provider_type: 'queue-operation',
        provider_subtype: 'enqueue',
      }),
      expect.objectContaining({ category: 'lifecycle', provider_type: 'last-prompt' }),
    ]);

    expect(child).toMatchObject({
      source_conversation_id: 'session-tree:agent:researcher',
      parent_source_conversation_id: 'session-tree',
      provider_metadata_json: {
        agentId: 'researcher',
        agentType: 'Explore',
        description: 'Inspect the Claude Code transcript format',
        spawnDepth: 1,
        toolUseId: 'spawn-tool',
        sessionId: 'session-tree',
      },
    });
    expect(child?.events.map((event) => event.source_event_id)).toEqual(['sub-u-1', 'sub-a-1']);
    expect(parent?.relations).toContainEqual({
      relation_type: 'spawn',
      source_event_id: 'a-main',
      target_source_conversation_id: 'session-tree:agent:researcher',
    });
    expect(parent?.events.some((event) => event.source_event_id === 'sub-u-1')).toBe(false);

    const repeated = await claudeCodeSource.readConversations!(files[0]);
    const withoutArchiveInstance = (conversation: (typeof result.conversations)[number]) => {
      const { raw_archive_manifest: _manifest, ...providerMetadata } = conversation.provider_metadata_json;
      return { ...conversation, provider_metadata_json: providerMetadata };
    };
    expect(repeated.conversations.map(withoutArchiveInstance)).toEqual(
      result.conversations.map(withoutArchiveInstance),
    );
  });

  it('archives every normalized source with matching SHA-256 provenance', async () => {
    const { root, sessionPath } = makeFixtureCopy();
    const [file] = await claudeCodeSource.discover({ paths: [sessionPath] });
    const result = await claudeCodeSource.readConversations!(file);

    const expectedMainHash = createHash('sha256')
      .update(readFileSync(sessionPath))
      .digest('hex');
    const parent = result.conversations.find(
      (conversation) => conversation.source_conversation_id === 'session-tree',
    );
    expect(parent?.source_sha256).toBe(expectedMainHash);

    const archiveRoot = join(root, 'ae-home', 'raw-archive');
    const [archiveName] = readdirSync(archiveRoot);
    const manifest = JSON.parse(
      readFileSync(join(archiveRoot, archiveName, 'manifest.json'), 'utf8'),
    ) as { files: Array<{ path: string; sha256: string }> };
    expect(manifest.files).toHaveLength(3);
    expect(manifest.files).toContainEqual(expect.objectContaining({
      path: sessionPath,
      sha256: expectedMainHash,
    }));
  });

  it('never discovers prompt history, credentials, or settings as transcripts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ae-claude-sensitive-'));
    tempDirs.push(root);
    const historyPath = join(root, 'history.jsonl');
    const credentialsPath = join(root, '.credentials.json');
    const settingsPath = join(root, 'settings.json');
    writeFileSync(historyPath, '{"display":"prompt only"}\n', 'utf8');
    writeFileSync(credentialsPath, '{"token":"secret"}\n', 'utf8');
    writeFileSync(settingsPath, '{"theme":"dark"}\n', 'utf8');

    const files = await claudeCodeSource.discover({
      paths: [historyPath, credentialsPath, settingsPath],
    });
    expect(files).toEqual([]);
  });

  it('ignores an incomplete tail but accepts a valid final record without a newline', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ae-claude-live-'));
    tempDirs.push(root);
    process.env.AE_HOME = join(root, 'ae-home');
    const sessionPath = join(root, 'live-session.jsonl');
    const firstRecord = JSON.stringify({
      type: 'user',
      sessionId: 'live-session',
      uuid: 'live-user',
      timestamp: '2026-08-10T20:00:00.000Z',
      message: { role: 'user', content: 'First complete record' },
    });
    const secondRecord = JSON.stringify({
      type: 'assistant',
      sessionId: 'live-session',
      uuid: 'live-assistant',
      parentUuid: 'live-user',
      timestamp: '2026-08-10T20:00:01.000Z',
      message: { role: 'assistant', content: 'Second complete record' },
    });
    writeFileSync(sessionPath, `${firstRecord}\n${secondRecord.slice(0, 30)}`, 'utf8');
    const [file] = await claudeCodeSource.discover({ paths: [sessionPath] });

    const partial = await claudeCodeSource.readConversations!(file);
    expect(partial.errors).toEqual([]);
    expect(partial.processedLines).toBe(1);
    expect(partial.conversations[0].events.map((event) => event.source_event_id)).toEqual([
      'live-user',
    ]);

    writeFileSync(sessionPath, `${firstRecord}\n${secondRecord}`, 'utf8');
    const [completedFile] = await claudeCodeSource.discover({ paths: [sessionPath] });
    const completed = await claudeCodeSource.readConversations!(completedFile);
    expect(completed.errors).toEqual([]);
    expect(completed.processedLines).toBe(2);
    expect(completed.conversations[0].events.map((event) => event.source_event_id)).toEqual([
      'live-user',
      'live-assistant',
    ]);
  });

  it('keeps the first canonical UUID event and audits later replayed records', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ae-claude-duplicates-'));
    tempDirs.push(root);
    process.env.AE_HOME = join(root, 'ae-home');
    const sessionPath = join(root, 'duplicate-session.jsonl');
    const records = [
      {
        type: 'user', sessionId: 'duplicate-session', uuid: 'shared-uuid',
        timestamp: '2026-08-10T20:00:00.000Z', promptId: 'first',
        message: { role: 'user', content: 'Canonical prompt' },
      },
      {
        type: 'assistant', sessionId: 'duplicate-session', uuid: 'assistant-uuid',
        parentUuid: 'shared-uuid', timestamp: '2026-08-10T20:00:01.000Z',
        message: { role: 'assistant', content: 'Canonical response' },
      },
      {
        type: 'user', sessionId: 'duplicate-session', uuid: 'shared-uuid',
        timestamp: '2026-08-10T20:00:00.000Z', promptId: 'replayed', slug: 'later-run',
        message: { role: 'user', content: 'Canonical prompt' },
      },
    ];
    writeFileSync(sessionPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
    const [file] = await claudeCodeSource.discover({ paths: [sessionPath] });

    const result = await claudeCodeSource.readConversations!(file);

    expect(result.conversations[0].events.map((event) => event.source_event_id)).toEqual([
      'shared-uuid', 'assistant-uuid',
    ]);
    expect(result.conversations[0].events.map((event) => event.sequence)).toEqual([0, 1]);
    expect(result.conversations[0].provider_metadata_json).toMatchObject({
      duplicate_event_records: [{
        source_event_id: 'shared-uuid',
        canonical_line: 1,
        duplicate_lines: [3],
      }],
    });
  });
});
