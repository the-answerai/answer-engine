import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEmptyFileCursor } from '../sync/cursor-store.js';
import { claudeCodeSource } from '../sync/sources/claude-code.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ae-sync-source-'));
  tempDirs.push(dir);
  return dir;
}

function writeJsonl(path: string, rows: Array<Record<string, unknown>>, trailing = true): void {
  writeFileSync(
    path,
    rows.map((row) => JSON.stringify(row)).join('\n') + (trailing ? '\n' : ''),
    'utf8'
  );
}

describe('claudeCodeSource', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('discovers and normalizes Claude Code JSONL turns', async () => {
    const dir = makeTempDir();
    const filePath = join(dir, 'conversation.jsonl');
    writeJsonl(filePath, [
      {
        type: 'user',
        sessionId: 'session-123',
        uuid: 'u-1',
        timestamp: '2026-06-01T12:00:00.000Z',
        message: { role: 'user', content: 'Remember this project detail' },
      },
      {
        type: 'assistant',
        sessionId: 'session-123',
        uuid: 'a-1',
        timestamp: '2026-06-01T12:00:02.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Got it.' }],
          model: 'claude-test',
        },
      },
    ]);

    const files = await claudeCodeSource.discover({ paths: [filePath] });
    expect(files).toHaveLength(1);

    const result = await claudeCodeSource.readNewTurns!(files[0], createEmptyFileCursor());

    expect(result.errors).toEqual([]);
    expect(result.turns).toHaveLength(2);
    expect(result.turns[0]).toMatchObject({
      sourceIdentifier: 'claude-code:session-123:u-1',
      conversationId: 'session-123',
      role: 'user',
      turnIndex: 0,
      content: 'Remember this project detail',
    });
    expect(result.turns[1]).toMatchObject({
      sourceIdentifier: 'claude-code:session-123:a-1',
      role: 'assistant',
      content: 'Got it.',
      metadata: expect.objectContaining({ model: 'claude-test' }),
    });
    expect(result.nextCursor.offset).toBeGreaterThan(0);
    expect(result.nextCursor.line).toBe(2);
  });

  it('resumes from cursor offset and leaves incomplete trailing records unread', async () => {
    const dir = makeTempDir();
    const filePath = join(dir, 'conversation.jsonl');
    writeJsonl(filePath, [
      {
        type: 'user',
        sessionId: 'session-123',
        uuid: 'u-1',
        message: { role: 'user', content: 'First' },
      },
    ]);

    const [file] = await claudeCodeSource.discover({ paths: [filePath] });
    const first = await claudeCodeSource.readNewTurns!(file, createEmptyFileCursor());
    expect(first.turns).toHaveLength(1);

    writeFileSync(
      filePath,
      JSON.stringify({
        type: 'user',
        sessionId: 'session-123',
        uuid: 'u-1',
        message: { role: 'user', content: 'First' },
      }) +
        '\n' +
        JSON.stringify({
          type: 'assistant',
          sessionId: 'session-123',
          uuid: 'a-1',
          message: { role: 'assistant', content: 'Second' },
        }),
      'utf8'
    );

    const [updatedFile] = await claudeCodeSource.discover({ paths: [filePath] });
    const second = await claudeCodeSource.readNewTurns!(updatedFile, first.nextCursor);

    expect(second.turns).toEqual([]);
    expect(second.nextCursor.line).toBe(1);

    writeFileSync(
      filePath,
      JSON.stringify({
        type: 'user',
        sessionId: 'session-123',
        uuid: 'u-1',
        message: { role: 'user', content: 'First' },
      }) +
        '\n' +
        JSON.stringify({
          type: 'assistant',
          sessionId: 'session-123',
          uuid: 'a-1',
          message: { role: 'assistant', content: 'Second' },
        }) +
        '\n',
      'utf8'
    );

    const [completedFile] = await claudeCodeSource.discover({ paths: [filePath] });
    const third = await claudeCodeSource.readNewTurns!(completedFile, second.nextCursor);

    expect(third.turns).toHaveLength(1);
    expect(third.turns[0].sourceIdentifier).toBe('claude-code:session-123:a-1');
    expect(third.nextCursor.line).toBe(2);
  });
});
