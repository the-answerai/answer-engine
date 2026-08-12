import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ImportRequest } from '../api-client.js';
import { resolveSyncSourcesFromConfig, runSyncOnce } from '../sync/sync-daemon.js';
import { UserConfigSchema } from '../user-config.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ae-local-dir-sync-'));
  tempDirs.push(dir);
  return dir;
}

function makeClient(contentId = 'content-local-1') {
  return {
    submitSyncImport: vi.fn(async (request: ImportRequest) => ({
      success: true,
      data: {
        totalItems: request.items.length,
        completedItems: request.items.length,
        failedItems: 0,
        contentIds: request.items.map(() => contentId),
        failures: [],
      },
    })),
    deleteContent: vi.fn(async () => undefined),
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('local_dir sync', () => {
  it('maps local directory config fields into daemon options', () => {
    const config = UserConfigSchema.parse({
      models: {
        chat: 'local-chat',
        embedding: 'local-embedding',
        chat_provider: 'lmstudio',
        embedding_provider: 'lmstudio',
        embedding_dimension: 768,
      },
      sources: [{
        type: 'local_dir',
        path: '/tmp/notes',
        include: ['**/*.md'],
        exclude: ['private/**'],
        content_type: 'document',
        on_delete: 'forget',
        max_file_bytes: 2048,
        library: 'memory',
      }],
    });

    expect(resolveSyncSourcesFromConfig(config)).toEqual([{
      sourceId: 'local_dir',
      paths: ['/tmp/notes'],
      include: ['**/*.md'],
      exclude: ['private/**'],
      contentType: 'document',
      onDelete: 'forget',
      maxFileBytes: 2048,
      librarySlug: 'memory',
    }]);
  });

  it('skips unchanged content and reimports edits under the same source identifier', async () => {
    const root = makeTempDir();
    const documentPath = join(root, 'note.md');
    const cursorFile = join(root, 'cursor.json');
    const client = makeClient();
    writeFileSync(documentPath, 'Version one', 'utf8');
    const options = {
      sourceId: 'local_dir' as const,
      paths: [root],
      cursorFile,
      batchSize: 25,
      client,
    };

    await runSyncOnce(options);
    await runSyncOnce(options);
    writeFileSync(documentPath, 'Version two', 'utf8');
    await runSyncOnce(options);

    expect(client.submitSyncImport).toHaveBeenCalledTimes(2);
    const [firstRequest] = client.submitSyncImport.mock.calls[0];
    const [secondRequest] = client.submitSyncImport.mock.calls[1];
    expect(firstRequest.items[0]).toMatchObject({
      content_type: 'document',
      source: 'local_dir',
      source_identifier: `local_dir:${resolve(documentPath)}`,
      content: 'Version one',
    });
    expect(secondRequest.items[0]).toMatchObject({
      source_identifier: firstRequest.items[0].source_identifier,
      content: 'Version two',
    });

    const cursor = JSON.parse(await readFile(cursorFile, 'utf8')) as {
      files: Record<string, { importedCount: number; sourceSha256?: string; contentId?: string }>;
    };
    expect(Object.values(cursor.files)).toEqual([
      expect.objectContaining({ importedCount: 2, contentId: 'content-local-1' }),
    ]);
  });

  it('removes the cursor but leaves remote content when a file is deleted by default', async () => {
    const root = makeTempDir();
    const documentPath = join(root, 'note.md');
    const cursorFile = join(root, 'cursor.json');
    const client = makeClient();
    writeFileSync(documentPath, 'Keep remote', 'utf8');
    const options = {
      sourceId: 'local_dir' as const,
      paths: [root],
      cursorFile,
      batchSize: 25,
      client,
    };

    await runSyncOnce(options);
    unlinkSync(documentPath);
    await runSyncOnce(options);

    expect(client.deleteContent).not.toHaveBeenCalled();
    const cursor = JSON.parse(await readFile(cursorFile, 'utf8')) as { files: Record<string, unknown> };
    expect(cursor.files).toEqual({});
  });

  it('forgets remote content by persisted content ID when configured', async () => {
    const root = makeTempDir();
    const documentPath = join(root, 'note.md');
    const cursorFile = join(root, 'cursor.json');
    const client = makeClient('content-to-forget');
    writeFileSync(documentPath, 'Forget remote', 'utf8');
    const options = {
      sourceId: 'local_dir' as const,
      paths: [root],
      cursorFile,
      batchSize: 25,
      onDelete: 'forget' as const,
      client,
    };

    await runSyncOnce(options);
    unlinkSync(documentPath);
    await runSyncOnce(options);

    expect(client.deleteContent).toHaveBeenCalledWith('content-to-forget');
    const cursor = JSON.parse(await readFile(cursorFile, 'utf8')) as { files: Record<string, unknown> };
    expect(cursor.files).toEqual({});
  });

  it('does not treat an oversize existing file as deleted', async () => {
    const root = makeTempDir();
    const documentPath = join(root, 'note.md');
    const cursorFile = join(root, 'cursor.json');
    const client = makeClient('content-still-present');
    const onWarning = vi.fn();
    writeFileSync(documentPath, 'Small', 'utf8');
    const options = {
      sourceId: 'local_dir' as const,
      paths: [root],
      cursorFile,
      batchSize: 25,
      maxFileBytes: 100,
      onDelete: 'forget' as const,
      client,
      onWarning,
    };

    await runSyncOnce(options);
    writeFileSync(documentPath, 'x'.repeat(200), 'utf8');
    await runSyncOnce(options);

    expect(client.deleteContent).not.toHaveBeenCalled();
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('skipped oversize file'));
    const cursor = JSON.parse(await readFile(cursorFile, 'utf8')) as { files: Record<string, unknown> };
    expect(Object.keys(cursor.files)).toEqual([`local_dir:${resolve(documentPath)}`]);
  });

  it('defers deletion when the configured source directory is unavailable', async () => {
    const root = makeTempDir();
    const sourceRoot = join(root, 'notes');
    const documentPath = join(sourceRoot, 'note.md');
    const cursorFile = join(root, 'cursor.json');
    const client = makeClient('content-on-unavailable-root');
    const onWarning = vi.fn();
    mkdirSync(sourceRoot);
    writeFileSync(documentPath, 'Mounted note', 'utf8');
    const options = {
      sourceId: 'local_dir' as const,
      paths: [sourceRoot],
      cursorFile,
      batchSize: 25,
      onDelete: 'forget' as const,
      client,
      onWarning,
    };

    await runSyncOnce(options);
    rmSync(sourceRoot, { recursive: true });
    await runSyncOnce(options);

    expect(client.deleteContent).not.toHaveBeenCalled();
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('source root is unavailable'));
    const cursor = JSON.parse(await readFile(cursorFile, 'utf8')) as { files: Record<string, unknown> };
    expect(Object.keys(cursor.files)).toEqual([`local_dir:${resolve(documentPath)}`]);
  });

  it('keeps a deleted-file cursor when forgetting fails so the next poll retries', async () => {
    const root = makeTempDir();
    const documentPath = join(root, 'note.md');
    const cursorFile = join(root, 'cursor.json');
    const client = makeClient('content-retry');
    writeFileSync(documentPath, 'Retry deletion', 'utf8');
    const options = {
      sourceId: 'local_dir' as const,
      paths: [root],
      cursorFile,
      batchSize: 25,
      onDelete: 'forget' as const,
      client,
      onWarning: vi.fn(),
    };
    await runSyncOnce(options);
    unlinkSync(documentPath);
    client.deleteContent.mockRejectedValueOnce(new Error('temporary delete failure'));

    const summary = await runSyncOnce(options);

    expect(summary.failedItems).toBe(1);
    const cursor = JSON.parse(await readFile(cursorFile, 'utf8')) as { files: Record<string, unknown> };
    expect(Object.keys(cursor.files)).toEqual([`local_dir:${resolve(documentPath)}`]);
  });
});
