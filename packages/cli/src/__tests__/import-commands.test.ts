import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnswerEngineClient, ImportRequest } from '../api-client.js';
import { createClient } from '../client.js';
import { registerImportCommands } from '../commands/import.js';

vi.mock('../client.js', () => ({
  createClient: vi.fn(),
  handleApiError: vi.fn((error: unknown) => {
    throw error;
  }),
}));

vi.mock('../output.js', () => ({
  isInteractiveOutput: vi.fn(() => false),
  printError: vi.fn(),
  printHeader: vi.fn(),
  printJson: vi.fn(),
  printWarning: vi.fn(),
}));

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  registerImportCommands(program);
  return program;
}

const tempDirs: string[] = [];

function writeTempFile(name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ae-import-'));
  tempDirs.push(dir);
  const filePath = join(dir, name);
  writeFileSync(filePath, contents);
  return filePath;
}

function mockClient() {
  const importPreview = vi.fn().mockResolvedValue({
    data: {
      rowCount: 2,
      sample: [],
      parseErrors: [],
      requiresIdForIdempotency: false,
    },
  });
  const submitImport = vi.fn().mockResolvedValue({
    data: {
      status: 'completed',
      totalItems: 2,
      requiresIdForIdempotency: false,
      parseErrors: [],
    },
  });

  vi.mocked(createClient).mockReturnValue({
    importPreview,
    submitImport,
  } as unknown as AnswerEngineClient);

  return { importPreview, submitImport };
}

describe('import commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('imports CSV with title, content, and URL auto-detection', async () => {
    const filePath = writeTempFile(
      'documents.csv',
      [
        'Name,Website,Description',
        'Acme,https://acme.com/about,CRM platform',
        'Beta,beta.io,Analytics product',
      ].join('\n')
    );
    const client = mockClient();

    await makeProgram().parseAsync(['node', 'ae', 'import', 'csv', filePath]);

    const request = client.importPreview.mock.calls[0][0] as ImportRequest;
    expect(request.items).toEqual([
      {
        title: 'Acme',
        content_type: 'document',
        content: 'CRM platform',
        source_identifier: 'https://acme.com/about',
        external_url: 'https://acme.com/about',
      },
      {
        title: 'Beta',
        content_type: 'document',
        content: 'Analytics product',
        source_identifier: 'https://beta.io',
        external_url: 'https://beta.io',
      },
    ]);
    expect(client.submitImport).toHaveBeenCalledWith(request);
  });

  it('imports JSON arrays and applies explicit content type', async () => {
    const filePath = writeTempFile(
      'items.json',
      JSON.stringify([
        {
          name: 'Example',
          url: 'example.com',
          description: 'Example profile',
        },
      ])
    );
    const client = mockClient();

    await makeProgram().parseAsync([
      'node',
      'ae',
      'import',
      'json',
      filePath,
      '--type',
      'document',
    ]);

    const request = client.importPreview.mock.calls[0][0] as ImportRequest;
    expect(request.items).toEqual([
      {
        title: 'Example',
        content_type: 'document',
        content: 'Example profile',
        source_identifier: 'https://example.com',
        external_url: 'https://example.com',
      },
    ]);
    expect(client.submitImport).toHaveBeenCalledWith(request);
  });

  it('preserves chat conversation columns as import fields', async () => {
    const filePath = writeTempFile(
      'chat.json',
      JSON.stringify([
        {
          title: 'Codex turn',
          content_type: 'chat',
          content: 'Remember thread context',
          source_identifier: 'codex-turn-1',
          source_agent_id: 'codex',
          conversation_id: 'conv-123',
          turn_index: 1,
          turn_role: 'assistant',
          turn_timestamp: '2026-06-01T12:01:00.000Z',
          turn_metadata: { model: 'gpt-test' },
        },
      ])
    );
    const client = mockClient();

    await makeProgram().parseAsync(['node', 'ae', 'import', 'json', filePath]);

    const request = client.importPreview.mock.calls[0][0] as ImportRequest;
    expect(request.items[0]).toMatchObject({
      source_agent_id: 'codex',
      conversation_id: 'conv-123',
      turn_index: 1,
      turn_role: 'assistant',
      turn_timestamp: '2026-06-01T12:01:00.000Z',
      turn_metadata: { model: 'gpt-test' },
    });
    expect(request.items[0]).not.toHaveProperty('metadata.import.conversation_id');
  });

  it('preserves structured import fields for API parsing', async () => {
    const filePath = writeTempFile(
      'structured.json',
      JSON.stringify([
        {
          title: 'Bid attachment',
          content_type: 'document',
          source_identifier: 'bid-attachment-1',
          analysis_data: { extraction: { status: 'success' } },
          source_data: { source: 'customer-documents' },
        },
      ])
    );
    const client = mockClient();

    await makeProgram().parseAsync(['node', 'ae', 'import', 'json', filePath]);

    const request = client.importPreview.mock.calls[0][0] as ImportRequest;
    expect(request.items[0]).toMatchObject({
      title: 'Bid attachment',
      content_type: 'document',
      source_identifier: 'bid-attachment-1',
      analysis_data: { extraction: { status: 'success' } },
      'source_data.source': 'customer-documents',
    });
    expect(request.items[0]).not.toHaveProperty('metadata.import.analysis_data');
  });

  it('dry-run validates and previews without submitting an import', async () => {
    const filePath = writeTempFile(
      'dry-run.csv',
      ['title,content', 'Preview note,Preview only'].join('\n')
    );
    const client = mockClient();

    await makeProgram().parseAsync([
      'node',
      'ae',
      'import',
      'csv',
      filePath,
      '--dry-run',
      '--type',
      'document',
    ]);

    expect(client.importPreview).toHaveBeenCalledTimes(1);
    expect(client.submitImport).not.toHaveBeenCalled();
    const request = client.importPreview.mock.calls[0][0] as ImportRequest;
    expect(request.items[0]).toMatchObject({
      title: 'Preview note',
      content_type: 'document',
      content: 'Preview only',
    });
  });
});
