import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnswerEngineClient, ImportRequest } from '../api-client.js';
import { createClient } from '../client.js';
import { registerSyncCommands } from '../commands/sync.js';
import { printJson, printSuccess } from '../output.js';
import {
  installService,
  queryServiceStatus,
  uninstallService,
} from '../sync/service.js';

vi.mock('../client.js', () => ({
  createClient: vi.fn(),
  handleApiError: vi.fn((error: unknown) => {
    throw error;
  }),
}));

vi.mock('../output.js', () => ({
  printError: vi.fn(),
  printHeader: vi.fn(),
  printJson: vi.fn(),
  printSuccess: vi.fn(),
}));

vi.mock('../sync/service.js', () => ({
  installService: vi.fn(),
  queryServiceStatus: vi.fn(),
  uninstallService: vi.fn(),
}));

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  registerSyncCommands(program);
  return program;
}

const tempDirs: string[] = [];
const originalAeHome = process.env.AE_HOME;
const claudeFixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'claude-code',
);
const coworkFixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'cowork',
  'local-agent-mode-sessions',
);

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ae-sync-command-'));
  tempDirs.push(dir);
  return dir;
}

function mockClient() {
  const submitSyncImport = vi.fn(async (request: ImportRequest) => ({
    data: {
      totalItems: request.items.length,
      completedItems: request.items.length,
      failedItems: 0,
      contentIds: request.items.map((_, index) => `content-${index + 1}`),
      failures: [] as Array<{ rowIndex?: number; error?: string; reason?: string }>,
    },
  }));

  vi.mocked(createClient).mockReturnValue({
    submitSyncImport,
  } as unknown as AnswerEngineClient);

  return { submitSyncImport };
}

describe('sync commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queryServiceStatus).mockReturnValue({
      platform: 'darwin',
      installed: true,
      running: true,
      enabled: true,
      unitPath: '/Users/test/Library/LaunchAgents/ai.answer-engine.sync.plist',
      detail: 'running (pid 42, last exit 0)',
    });
    vi.mocked(installService).mockReturnValue({
      platform: 'darwin',
      unitPath: '/Users/test/Library/LaunchAgents/ai.answer-engine.sync.plist',
    });
    vi.mocked(uninstallService).mockReturnValue({
      platform: 'darwin',
      unitPath: '/Users/test/Library/LaunchAgents/ai.answer-engine.sync.plist',
    });
  });

  afterEach(() => {
    if (originalAeHome === undefined) delete process.env.AE_HOME;
    else process.env.AE_HOME = originalAeHome;

    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses every config.yaml source when source and path flags are absent', async () => {
    const dir = makeTempDir();
    const firstTranscript = join(dir, 'first.jsonl');
    const secondTranscript = join(dir, 'second.jsonl');
    const makeTurn = (sessionId: string, uuid: string, content: string) => JSON.stringify({
      type: 'user',
      sessionId,
      uuid,
      timestamp: '2026-06-01T12:00:00.000Z',
      message: { role: 'user', content },
    }) + '\n';
    writeFileSync(firstTranscript, makeTurn('session-1', 'u-1', 'First source'), 'utf8');
    writeFileSync(secondTranscript, makeTurn('session-2', 'u-2', 'Second source'), 'utf8');

    process.env.AE_HOME = join(dir, 'home');
    mkdirSync(process.env.AE_HOME, { recursive: true });
    writeFileSync(join(process.env.AE_HOME, 'config.yaml'), `
models:
  chat: local-chat
  embedding: local-embedding
  chat_provider: lmstudio
  embedding_provider: lmstudio
  embedding_dimension: 768
sources:
  - type: claude-code
    path: ${firstTranscript}
    library: first-library
  - type: claude-code
    path: ${secondTranscript}
    library: second-library
`);
    const client = mockClient();

    await makeProgram().parseAsync(['node', 'ae', 'sync', 'once']);

    expect(client.submitSyncImport).toHaveBeenCalledTimes(2);
    expect(client.submitSyncImport.mock.calls.map(([request]) => request.librarySlug)).toEqual([
      'first-library',
      'second-library',
    ]);
  });

  it('sync once imports a Claude Code conversation and skips an unchanged rerun', async () => {
    const dir = makeTempDir();
    const transcript = join(dir, 'conversation.jsonl');
    const cursorFile = join(dir, 'cursor.json');
    process.env.AE_HOME = join(dir, 'home');
    writeFileSync(
      transcript,
      [
        JSON.stringify({
          type: 'user',
          sessionId: 'session-123',
          uuid: 'u-1',
          timestamp: '2026-06-01T12:00:00.000Z',
          message: { role: 'user', content: 'Capture this' },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'session-123',
          uuid: 'a-1',
          timestamp: '2026-06-01T12:00:01.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Captured.' }] },
        }),
      ].join('\n') + '\n',
      'utf8'
    );
    const client = mockClient();

    await makeProgram().parseAsync([
      'node',
      'ae',
      'sync',
      'once',
      '--path',
      transcript,
      '--cursor-file',
      cursorFile,
      '--library',
      'personal-memory',
      '--batch-size',
      '2',
    ]);

    expect(client.submitSyncImport).toHaveBeenCalledTimes(1);
    const request = client.submitSyncImport.mock.calls[0][0] as ImportRequest;
    expect(request.librarySlug).toBe('personal-memory');
    expect(request.items).toHaveLength(1);
    expect(request.items[0]).toMatchObject({
      content_type: 'chat',
      source: 'claude-code',
      source_agent_id: 'claude',
      source_identifier: 'anthropic_claude:claude_code:session-123',
      conversation_id: 'session-123',
      content: expect.stringContaining('[user] Capture this'),
      'metadata.sync.adapter_name': 'claude-code-history',
    });
    expect(request.items[0]['source_data.chat_interchange']).toMatchObject({
      events: [
        expect.objectContaining({ source_event_id: 'u-1' }),
        expect.objectContaining({ source_event_id: 'a-1' }),
      ],
    });

    const cursor = JSON.parse(await readFile(cursorFile, 'utf8')) as {
      files: Record<string, { importedCount: number; line: number; offset: number }>;
    };
    const [fileCursor] = Object.values(cursor.files);
    expect(fileCursor.importedCount).toBe(1);
    expect(fileCursor.line).toBe(2);
    expect(fileCursor.offset).toBeGreaterThan(0);

    client.submitSyncImport.mockClear();
    await makeProgram().parseAsync([
      'node',
      'ae',
      'sync',
      'once',
      '--path',
      transcript,
      '--cursor-file',
      cursorFile,
    ]);

    expect(client.submitSyncImport).not.toHaveBeenCalled();
  });

  it('does not advance the cursor when synchronous import reports row failures', async () => {
    const dir = makeTempDir();
    const transcript = join(dir, 'conversation.jsonl');
    const cursorFile = join(dir, 'cursor.json');
    process.env.AE_HOME = join(dir, 'home');
    writeFileSync(
      transcript,
      [
        JSON.stringify({
          type: 'user',
          sessionId: 'session-123',
          uuid: 'u-1',
          timestamp: '2026-06-01T12:00:00.000Z',
          message: { role: 'user', content: 'Capture this' },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'session-123',
          uuid: 'a-1',
          timestamp: '2026-06-01T12:00:01.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Retry me.' }] },
        }),
      ].join('\n') + '\n',
      'utf8'
    );
    const client = mockClient();
    client.submitSyncImport.mockResolvedValueOnce({
      data: {
        totalItems: 1,
        completedItems: 0,
        failedItems: 1,
        contentIds: [],
        failures: [{ rowIndex: 0, error: 'temporary failure' }],
      },
    });

    await makeProgram().parseAsync([
      'node',
      'ae',
      'sync',
      'once',
      '--path',
      transcript,
      '--cursor-file',
      cursorFile,
      '--batch-size',
      '2',
    ]);

    const cursor = JSON.parse(await readFile(cursorFile, 'utf8')) as {
      files: Record<string, { importedCount: number; line: number; offset: number }>;
    };
    expect(Object.values(cursor.files)).toEqual([]);

    client.submitSyncImport.mockClear();
    client.submitSyncImport.mockResolvedValueOnce({
      data: {
        totalItems: 1,
        completedItems: 1,
        failedItems: 0,
        contentIds: ['content-1'],
        failures: [],
      },
    });

    await makeProgram().parseAsync([
      'node',
      'ae',
      'sync',
      'once',
      '--path',
      transcript,
      '--cursor-file',
      cursorFile,
      '--batch-size',
      '2',
    ]);

    expect(client.submitSyncImport).toHaveBeenCalledTimes(1);
  });

  it('reimports separate parent and child conversations after a subagent-only change', async () => {
    const dir = makeTempDir();
    const transcriptRoot = join(dir, 'claude-project');
    const cursorFile = join(dir, 'cursor.json');
    cpSync(claudeFixtureDir, transcriptRoot, { recursive: true });
    process.env.AE_HOME = join(dir, 'home');
    const client = mockClient();
    const args = [
      'node',
      'ae',
      'sync',
      'once',
      '--path',
      transcriptRoot,
      '--cursor-file',
      cursorFile,
    ];

    await makeProgram().parseAsync(args);

    expect(client.submitSyncImport).toHaveBeenCalledTimes(1);
    const initialRequest = client.submitSyncImport.mock.calls[0][0] as ImportRequest;
    expect(initialRequest.items.map((item) => item.source_identifier)).toEqual([
      'anthropic_claude:claude_code:session-tree',
      'anthropic_claude:claude_code:session-tree:agent:researcher',
    ]);

    client.submitSyncImport.mockClear();
    await makeProgram().parseAsync(args);
    expect(client.submitSyncImport).not.toHaveBeenCalled();

    appendFileSync(
      join(transcriptRoot, 'session-tree', 'subagents', 'agent-researcher.jsonl'),
      `${JSON.stringify({
        type: 'assistant',
        sessionId: 'session-tree',
        agentId: 'researcher',
        uuid: 'sub-a-2',
        parentUuid: 'sub-a-1',
        timestamp: '2026-08-10T20:00:02.000Z',
        message: { role: 'assistant', content: 'A new subagent-only event.' },
      })}\n`,
      'utf8',
    );
    await makeProgram().parseAsync(args);

    expect(client.submitSyncImport).toHaveBeenCalledTimes(1);
    const changedRequest = client.submitSyncImport.mock.calls[0][0] as ImportRequest;
    expect(changedRequest.items).toHaveLength(2);
    expect(changedRequest.items[1]['source_data.chat_interchange']).toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({ source_event_id: 'sub-a-2' }),
      ]),
    });
  });

  it('sync once imports Cowork nested conversations without audit message duplication', async () => {
    const dir = makeTempDir();
    const transcriptRoot = join(dir, 'local-agent-mode-sessions');
    const cursorFile = join(dir, 'cursor.json');
    cpSync(coworkFixtureDir, transcriptRoot, { recursive: true });
    process.env.AE_HOME = join(dir, 'home');
    const client = mockClient();

    await makeProgram().parseAsync([
      'node',
      'ae',
      'sync',
      'once',
      '--source',
      'cowork',
      '--path',
      transcriptRoot,
      '--cursor-file',
      cursorFile,
    ]);

    expect(client.submitSyncImport).toHaveBeenCalledTimes(1);
    const request = client.submitSyncImport.mock.calls[0][0] as ImportRequest;
    expect(request.items).toHaveLength(2);
    const parent = request.items.find(
      (item) => item.source_identifier === 'anthropic_claude:claude_cowork:cowork-session',
    );
    expect(parent).toMatchObject({
      source: 'cowork',
      conversation_id: 'cowork-session',
      'metadata.sync.adapter_name': 'cowork-history',
      'metadata.provider_metadata_json': {
        sensitive_metadata: ['cowork_session'],
      },
    });
    expect(parent?.content).toContain('Canonical nested Cowork prompt');
    expect(parent?.content).not.toContain('Audit duplicate prompt');
  });

  it('reports service liveness and grouped cursor summaries for configured sources', async () => {
    const home = makeTempDir();
    const cursorFile = join(home, 'data', 'sync-cursors.json');
    process.env.AE_HOME = home;
    mkdirSync(join(home, 'data'), { recursive: true });
    writeFileSync(join(home, 'config.yaml'), `
models:
  chat: local-chat
  embedding: local-embedding
  chat_provider: lmstudio
  embedding_provider: lmstudio
  embedding_dimension: 768
sources:
  - type: claude-code
  - type: codex
`);
    writeFileSync(cursorFile, JSON.stringify({
      version: 1,
      files: {
        'claude-code:/one.jsonl': {
          offset: 10,
          line: 1,
          importedCount: 2,
          skippedCount: 1,
          fileSize: 10,
          lastMtimeMs: 100,
          updatedAt: '2026-08-11T10:00:00.000Z',
        },
        'claude-code:/two.jsonl': {
          offset: 20,
          line: 2,
          importedCount: 3,
          skippedCount: 0,
          fileSize: 20,
          lastMtimeMs: 200,
          updatedAt: '2026-08-11T11:00:00.000Z',
        },
      },
    }));

    await makeProgram().parseAsync(['node', 'ae', 'sync', 'status']);

    expect(printJson).toHaveBeenCalledWith({
      data: expect.objectContaining({
        service: expect.objectContaining({ installed: true, running: true }),
        cursorFile,
        sources: [
          {
            sourceId: 'claude-code',
            configured: true,
            files: 2,
            importedCount: 5,
            skippedCount: 1,
            lastUpdatedAt: '2026-08-11T11:00:00.000Z',
          },
          {
            sourceId: 'codex',
            configured: true,
            files: 0,
            importedCount: 0,
            skippedCount: 0,
          },
        ],
        files: expect.arrayContaining([
          expect.objectContaining({ key: 'claude-code:/one.jsonl', importedCount: 2 }),
        ]),
      }),
    });
  });

  it('reports observed cursor sources when config.yaml is unavailable', async () => {
    const home = makeTempDir();
    const cursorFile = join(home, 'sync-cursors.json');
    process.env.AE_HOME = home;
    writeFileSync(cursorFile, JSON.stringify({
      version: 1,
      files: {
        'codex:/session.jsonl': {
          offset: 30,
          line: 3,
          importedCount: 1,
          skippedCount: 0,
          fileSize: 30,
          lastMtimeMs: 300,
        },
      },
    }));

    await makeProgram().parseAsync([
      'node',
      'ae',
      'sync',
      'status',
      '--cursor-file',
      cursorFile,
    ]);

    expect(printJson).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sources: [{
          sourceId: 'codex',
          configured: false,
          files: 1,
          importedCount: 1,
          skippedCount: 0,
        }],
      }),
    });
  });

  it('installs and uninstalls the background service through sync subcommands', async () => {
    await makeProgram().parseAsync(['node', 'ae', 'sync', 'install-service']);
    await makeProgram().parseAsync(['node', 'ae', 'sync', 'uninstall-service']);

    expect(installService).toHaveBeenCalledTimes(1);
    expect(uninstallService).toHaveBeenCalledTimes(1);
    expect(printSuccess).toHaveBeenCalledWith(expect.stringContaining('Installed'));
    expect(printSuccess).toHaveBeenCalledWith(expect.stringContaining('Uninstalled'));
    expect(printJson).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'install-service' }),
    }));
    expect(printJson).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'uninstall-service' }),
    }));
  });
});
