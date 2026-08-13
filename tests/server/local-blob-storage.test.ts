import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalBlobStorage } from '../../src/services/storage/local-blob-storage.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('local blob storage', () => {
  it('stores bytes beneath its root and rejects traversal keys', async () => {
    const root = await mkdtemp(join(tmpdir(), 'answer-engine-blobs-'));
    roots.push(root);
    const storage = new LocalBlobStorage(root);
    const data = Buffer.from('preserved local evidence');
    const stored = await storage.write({ tenantId: randomUUID(), contentId: randomUUID(), data });

    await expect(storage.read(stored.storageKey)).resolves.toEqual(data);
    await expect(storage.read('../outside')).rejects.toThrow('Invalid blob storage key');
    await storage.remove(stored.storageKey);
    await expect(storage.read(stored.storageKey)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
