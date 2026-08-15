import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  assertFirstImportManifestMatchesSession,
  writeFirstImportManifest,
} from '../sync/first-import.js';
import {
  installService,
  queryServiceStatus,
  uninstallService,
} from '../sync/service.js';
import { writeRawArchive } from '../sync/raw-archive.js';

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
const originalExitCode = process.exitCode;
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

function discoveryFingerprint(sourceId: string, path: string): string {
  const stats = statSync(path);
  const hash = createHash('sha256');
  hash.update(sourceId);
  hash.update('\0');
  hash.update([
    path,
    `${stats.dev}:${stats.ino}`,
    String(stats.size),
    String(stats.mtimeMs),
  ].join('\0'));
  return hash.digest('hex');
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
  const getRawArchiveReferences = vi.fn(async () => ({
    data: { manifestPaths: [] as string[] },
  }));

  vi.mocked(createClient).mockReturnValue({
    submitSyncImport,
    getRawArchiveReferences,
  } as unknown as AnswerEngineClient);

  return { submitSyncImport, getRawArchiveReferences };
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
    process.exitCode = originalExitCode;

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

  it('resumes an approved first import from durable item and cursor state', async () => {
    const dir = makeTempDir();
    const transcript = join(dir, 'resume.jsonl');
    const cursorFile = join(dir, 'cursor.json');
    const home = join(dir, 'home');
    process.env.AE_HOME = home;
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.yaml'), `models:\n  chat: local-chat\n  embedding: local-embedding\n  chat_provider: lmstudio\n  embedding_provider: lmstudio\n  embedding_dimension: 768\nsources: []\nconnectors: {}\nserver:\n  port: 5050\n  bind: 127.0.0.1\n`);
    writeFileSync(transcript, `${JSON.stringify({
      type: 'user', sessionId: 'resume-session', uuid: 'resume-user',
      timestamp: '2026-06-01T12:00:00.000Z',
      message: { role: 'user', content: 'Resume this durable memory.' },
    })}\n`);
    const session = {
      id: '11111111-1111-4111-8111-111111111111', status: 'running' as const,
      manifestPath: join(home, 'data', 'first-import', 'manifest.json'),
      selectedSourceIds: ['claude-code' as const], approvedAt: '2026-08-14T12:00:00.000Z',
      counts: { discovered: 0, imported: 0, duplicate: 0, failed: 0, skipped: 0 }, pending: 1,
      sources: [{
        sourceId: 'claude-code' as const, label: 'Claude Code', paths: [dir],
        estimatedCount: 1, estimatedBytes: statSync(transcript).size,
        privacyPosture: 'Metadata only before approval.', exclusions: ['prompt history'],
        availability: 'available' as const, availabilityNote: 'Local source history is available for selection.',
        status: 'running', errorCode: null, recoveryAction: null,
      }],
      items: [{
        sourceId: 'claude-code' as const, fingerprint: discoveryFingerprint('claude-code', transcript), sourcePath: transcript,
        byteSize: 100, modifiedAt: '2026-08-14T12:00:00.000Z', outcome: 'pending' as const,
        contentIds: [], archiveManifestPath: null, errorCode: null, recoveryAction: null,
      }],
    };
    writeFirstImportManifest(session.manifestPath, session.id, [{
      sourceId: session.sources[0].sourceId,
      label: session.sources[0].label,
      paths: session.sources[0].paths,
      estimatedCount: session.sources[0].estimatedCount,
      estimatedBytes: session.sources[0].estimatedBytes,
      privacyPosture: session.sources[0].privacyPosture,
      exclusions: session.sources[0].exclusions,
      availability: session.sources[0].availability,
      availabilityNote: session.sources[0].availabilityNote,
      items: session.items.map(({ fingerprint, sourcePath, byteSize, modifiedAt }) => ({
        fingerprint, sourcePath, byteSize, modifiedAt,
      })),
    }]);
    expect(() => assertFirstImportManifestMatchesSession(session)).not.toThrow();
    const submitSyncImport = vi.fn(async (request: ImportRequest) => ({ data: {
      totalItems: request.items.length, completedItems: request.items.length,
      createdItems: request.items.length, updatedItems: 0, duplicateItems: 0,
      failedItems: 0, contentIds: ['22222222-2222-4222-8222-222222222222'], failures: [],
    } }));
    const recordFirstImportEvent = vi.fn().mockResolvedValue({ data: session });
    const completeFirstImport = vi.fn().mockResolvedValue({
      data: { ...session, status: 'completed', pending: 0, counts: { discovered: 1, imported: 1, duplicate: 0, failed: 0, skipped: 0 } },
    });
    vi.mocked(createClient).mockReturnValue({
      submitSyncImport,
      getFirstImport: vi.fn().mockResolvedValue({ data: session }),
      recordFirstImportEvent,
      completeFirstImport,
    } as unknown as AnswerEngineClient);

    await makeProgram().parseAsync([
      'node', 'ae', 'sync', 'first-import', '--resume', session.id,
      '--cursor-file', cursorFile,
    ]);

    expect(recordFirstImportEvent).toHaveBeenCalledWith(session.id, expect.objectContaining({
      outcome: 'imported',
      contentIds: ['22222222-2222-4222-8222-222222222222'],
      archiveManifestPath: expect.stringContaining('manifest.json'),
    }));
    expect(completeFirstImport).toHaveBeenCalledWith(session.id);
  });

  it('does not read or import a history bundle that changed after approval', async () => {
    const dir = makeTempDir();
    const transcript = join(dir, 'changed.jsonl');
    const home = join(dir, 'home');
    process.env.AE_HOME = home;
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.yaml'), `models:\n  chat: local-chat\n  embedding: local-embedding\n  chat_provider: lmstudio\n  embedding_provider: lmstudio\n  embedding_dimension: 768\nsources: []\nconnectors: {}\nserver:\n  port: 5050\n  bind: 127.0.0.1\n`);
    writeFileSync(transcript, '{"type":"user"}\n');
    const approvedFingerprint = discoveryFingerprint('claude-code', transcript);
    appendFileSync(transcript, '{"type":"assistant"}\n');
    const session = {
      id: '11111111-1111-4111-8111-111111111112', status: 'running' as const,
      manifestPath: join(home, 'data', 'first-import', 'manifest.json'),
      selectedSourceIds: ['claude-code' as const], approvedAt: '2026-08-14T12:00:00.000Z',
      counts: { discovered: 0, imported: 0, duplicate: 0, failed: 0, skipped: 0 }, pending: 1,
      sources: [{
        sourceId: 'claude-code' as const, label: 'Claude Code', paths: [dir],
        estimatedCount: 1, estimatedBytes: 16,
        privacyPosture: 'Metadata only before approval.', exclusions: ['prompt history'],
        availability: 'available' as const, availabilityNote: 'Local source history is available for selection.',
        status: 'running', errorCode: null, recoveryAction: null,
      }],
      items: [{
        sourceId: 'claude-code' as const, fingerprint: approvedFingerprint, sourcePath: transcript,
        byteSize: 16, modifiedAt: '2026-08-14T12:00:00.000Z', outcome: 'pending' as const,
        contentIds: [], archiveManifestPath: null, errorCode: null, recoveryAction: null,
      }],
    };
    writeFirstImportManifest(session.manifestPath, session.id, [{
      sourceId: session.sources[0].sourceId,
      label: session.sources[0].label,
      paths: session.sources[0].paths,
      estimatedCount: session.sources[0].estimatedCount,
      estimatedBytes: session.sources[0].estimatedBytes,
      privacyPosture: session.sources[0].privacyPosture,
      exclusions: session.sources[0].exclusions,
      availability: session.sources[0].availability,
      availabilityNote: session.sources[0].availabilityNote,
      items: session.items.map(({ fingerprint, sourcePath, byteSize, modifiedAt }) => ({
        fingerprint, sourcePath, byteSize, modifiedAt,
      })),
    }]);
    expect(() => assertFirstImportManifestMatchesSession(session)).not.toThrow();
    const submitSyncImport = vi.fn();
    const recordFirstImportEvent = vi.fn().mockResolvedValue({ data: session });
    vi.mocked(createClient).mockReturnValue({
      submitSyncImport,
      getFirstImport: vi.fn().mockResolvedValue({ data: session }),
      recordFirstImportEvent,
      completeFirstImport: vi.fn().mockResolvedValue({
        data: { ...session, status: 'failed', pending: 0, counts: { discovered: 1, imported: 0, duplicate: 0, failed: 1, skipped: 0 } },
      }),
    } as unknown as AnswerEngineClient);

    await makeProgram().parseAsync(['node', 'ae', 'sync', 'first-import', '--resume', session.id]);

    expect(submitSyncImport).not.toHaveBeenCalled();
    expect(recordFirstImportEvent).toHaveBeenCalledWith(session.id, expect.objectContaining({
      outcome: 'failed',
      errorCode: 'SOURCE_CHANGED_SINCE_APPROVAL',
      recoveryAction: expect.stringContaining('fresh source inventory'),
    }));
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
    expect(process.exitCode).toBe(1);

    client.submitSyncImport.mockClear();
    process.exitCode = undefined;
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

  it('checkpoints each successful file before a later file fails', async () => {
    const dir = makeTempDir();
    const firstTranscript = join(dir, 'first.jsonl');
    const secondTranscript = join(dir, 'second.jsonl');
    const cursorFile = join(dir, 'cursor.json');
    process.env.AE_HOME = join(dir, 'home');
    const makeTurn = (sessionId: string, content: string) => `${JSON.stringify({
      type: 'user',
      sessionId,
      uuid: `${sessionId}-user`,
      timestamp: '2026-06-01T12:00:00.000Z',
      message: { role: 'user', content },
    })}\n`;
    writeFileSync(firstTranscript, makeTurn('session-first', 'First durable memory'), 'utf8');
    writeFileSync(secondTranscript, makeTurn('session-second', 'Second durable memory'), 'utf8');
    const client = mockClient();
    client.submitSyncImport
      .mockResolvedValueOnce({
        data: {
          totalItems: 1,
          completedItems: 1,
          failedItems: 0,
          contentIds: ['content-first'],
          failures: [],
        },
      })
      .mockRejectedValueOnce(new Error('interrupted after first file'));

    await expect(makeProgram().parseAsync([
      'node',
      'ae',
      'sync',
      'once',
      '--path',
      firstTranscript,
      '--path',
      secondTranscript,
      '--cursor-file',
      cursorFile,
      '--concurrency',
      '1',
    ])).rejects.toThrow('interrupted after first file');

    const cursor = JSON.parse(await readFile(cursorFile, 'utf8')) as {
      files: Record<string, { importedCount: number }>;
    };
    expect(cursor.files[`claude-code:${firstTranscript}`]?.importedCount).toBe(1);
    expect(cursor.files[`claude-code:${secondTranscript}`]).toBeUndefined();
  });

  it('bounds concurrent history-file imports while preserving every cursor', async () => {
    const dir = makeTempDir();
    const cursorFile = join(dir, 'cursor.json');
    process.env.AE_HOME = join(dir, 'home');
    const transcripts = Array.from({ length: 5 }, (_, index) => {
      const transcript = join(dir, `conversation-${index}.jsonl`);
      writeFileSync(transcript, `${JSON.stringify({
        type: 'user',
        sessionId: `session-${index}`,
        uuid: `user-${index}`,
        timestamp: '2026-06-01T12:00:00.000Z',
        message: { role: 'user', content: `Durable memory ${index}` },
      })}\n`, 'utf8');
      return transcript;
    });
    const client = mockClient();
    let active = 0;
    let maxActive = 0;
    let releaseConcurrentImports: (() => void) | undefined;
    const concurrentImports = new Promise<void>((resolve) => {
      releaseConcurrentImports = resolve;
    });
    client.submitSyncImport.mockImplementation(async (request) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (active === 2) releaseConcurrentImports?.();
      await concurrentImports;
      active -= 1;
      return {
        data: {
          totalItems: request.items.length,
          completedItems: request.items.length,
          failedItems: 0,
          contentIds: request.items.map((_, index) => `content-${index + 1}`),
          failures: [],
        },
      };
    });

    await makeProgram().parseAsync([
      'node', 'ae', 'sync', 'once',
      ...transcripts.flatMap((transcript) => ['--path', transcript]),
      '--cursor-file', cursorFile,
      '--concurrency', '2',
    ]);

    expect(maxActive).toBe(2);
    const cursor = JSON.parse(await readFile(cursorFile, 'utf8')) as {
      files: Record<string, { importedCount: number }>;
    };
    expect(Object.keys(cursor.files)).toHaveLength(5);
    expect(Object.values(cursor.files).every(({ importedCount }) => importedCount === 1)).toBe(true);
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

  it('previews and explicitly confirms deletion of only unreferenced raw archives', async () => {
    const home = makeTempDir();
    process.env.AE_HOME = home;
    const firstSource = join(home, 'first.jsonl');
    const secondSource = join(home, 'second.jsonl');
    writeFileSync(firstSource, 'first');
    writeFileSync(secondSource, 'second');
    const first = await writeRawArchive([firstSource], {
      adapterName: 'test-adapter', adapterVersion: '1.0.0', createdAt: '2026-08-01T00:00:00.000Z',
    });
    const second = await writeRawArchive([secondSource], {
      adapterName: 'test-adapter', adapterVersion: '1.0.0', createdAt: '2026-08-02T00:00:00.000Z',
    });
    const client = mockClient();
    client.getRawArchiveReferences.mockResolvedValue({
      data: { manifestPaths: [first.manifestPath] },
    });

    await makeProgram().parseAsync([
      'node', 'ae', 'sync', 'archive', 'plan', '--target-bytes', '0',
    ]);
    const preview = vi.mocked(printJson).mock.calls.at(-1)?.[0] as {
      data: { confirmationToken: string; candidates: Array<{ manifestPath: string }> };
    };
    expect(preview.data.candidates.map((candidate) => candidate.manifestPath)).toEqual([
      second.manifestPath,
    ]);
    expect(existsSync(second.archiveDir)).toBe(true);

    vi.mocked(queryServiceStatus).mockReturnValue({
      platform: 'darwin', installed: true, running: false, enabled: false,
      unitPath: '/Users/test/Library/LaunchAgents/ai.answer-engine.sync.plist',
      detail: 'stopped',
    });
    await makeProgram().parseAsync([
      'node', 'ae', 'sync', 'archive', 'prune', '--target-bytes', '0',
      '--confirm', preview.data.confirmationToken,
    ]);

    expect(existsSync(first.archiveDir)).toBe(true);
    expect(existsSync(second.archiveDir)).toBe(false);
    expect(printSuccess).toHaveBeenCalledWith(expect.stringContaining('1 unreferenced raw archive'));
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
