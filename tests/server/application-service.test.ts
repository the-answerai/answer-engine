import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../src/config/database.js';
import type { LanguageProvider } from '../../src/services/ai/openai-compatible.js';
import { ApplicationService } from '../../src/services/application/application-service.js';
import type { LocalBlobStorage } from '../../src/services/storage/local-blob-storage.js';

describe('ApplicationService storage consistency', () => {
  it('removes blob bytes when metadata persistence fails', async () => {
    const tenantId = randomUUID();
    const contentId = randomUUID();
    const storageKey = `${tenantId}/${contentId}/${randomUUID()}.blob`;
    const persistenceError = new Error('metadata insert failed');
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: contentId }] })
      .mockRejectedValueOnce(persistenceError);
    const remove = vi.fn().mockResolvedValue(undefined);
    const storage = {
      write: vi.fn().mockResolvedValue({
        storageKey,
        byteSize: 8,
        sha256: 'a'.repeat(64),
      }),
      remove,
    } as unknown as LocalBlobStorage;
    const language: LanguageProvider = { embed: vi.fn(), complete: vi.fn() };
    const service = new ApplicationService(
      { query } as unknown as Database,
      language,
      storage,
    );

    await expect(service.uploadBlob(
      { tenantId, apiKeyId: randomUUID() },
      contentId,
      {
        fileName: 'evidence.txt',
        mediaType: 'text/plain',
        dataBase64: Buffer.from('evidence').toString('base64'),
        sourceMetadata: {},
      },
    )).rejects.toBe(persistenceError);

    expect(remove).toHaveBeenCalledWith(storageKey);
  });
});
