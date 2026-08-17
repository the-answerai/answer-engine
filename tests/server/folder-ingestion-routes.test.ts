import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../../src/middleware/error-handler.js';
import { createFolderIngestionRoutes } from '../../src/routes/folder-ingestion-routes.js';
import type { FolderIngestionService } from '../../src/services/folder-ingestion/folder-ingestion-service.js';

function routeApp(service: Partial<FolderIngestionService>, capabilities: readonly ('read' | 'write')[] = ['read', 'write']) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenantId = randomUUID(); req.apiKeyId = randomUUID(); req.apiCapabilities = capabilities; next();
  });
  app.use('/api/v1/folder-sources', createFolderIngestionRoutes(service as FolderIngestionService));
  app.use(errorHandler);
  return app;
}

const discovery = {
  rootPath: '/Users/local/Documents/notes', includePatterns: ['**/*.md'], excludePatterns: ['private/**'],
  maxFileBytes: 1024, maxTotalBytes: 4096, symlinkPolicy: 'no_follow',
  manifestPath: '/channel/data/folder-ingestion/preview.json',
  inventory: [{ sourcePath: '/Users/local/Documents/notes/a.md', relativePath: 'a.md', fileType: '.md',
    byteSize: 12, modifiedAt: '2026-08-15T12:00:00.000Z', disposition: 'candidate',
    reason: 'Supported text file', metadataFingerprint: 'a'.repeat(64), change: 'added' }],
};

describe('folder ingestion routes', () => {
  it('registers only a strictly validated metadata preview', async () => {
    const register = vi.fn().mockResolvedValue({ id: randomUUID(), status: 'previewed' });
    const response = await request(routeApp({ register })).post('/api/v1/folder-sources').send(discovery);
    expect(response.status).toBe(201);
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ tenantId: expect.any(String) }), discovery);
  });

  it('rejects incomplete applied lineage before reaching the service', async () => {
    const recordEvent = vi.fn();
    const response = await request(routeApp({ recordEvent }))
      .post(`/api/v1/folder-sources/runs/${randomUUID()}/events`)
      .send({ relativePath: 'a.md', outcome: 'imported' });
    expect(response.status).toBe(400);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('allows read-only inspection but requires write capability for approval and removal', async () => {
    const latest = vi.fn().mockResolvedValue(null);
    const approve = vi.fn();
    const prepareRemoval = vi.fn();
    const app = routeApp({ latest, approve, prepareRemoval }, ['read']);
    expect((await request(app).get('/api/v1/folder-sources/latest')).status).toBe(200);
    expect((await request(app).post(`/api/v1/folder-sources/runs/${randomUUID()}/approve`)).status).toBe(403);
    expect((await request(app).post(`/api/v1/folder-sources/${randomUUID()}/remove`).send({ retention: 'keep' })).status).toBe(403);
    expect(approve).not.toHaveBeenCalled(); expect(prepareRemoval).not.toHaveBeenCalled();
  });
});
