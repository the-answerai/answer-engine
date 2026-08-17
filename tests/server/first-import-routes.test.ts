import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createFirstImportRoutes } from '../../src/routes/first-import-routes.js';
import type { FirstImportService } from '../../src/services/first-import/first-import-service.js';
import { errorHandler } from '../../src/middleware/error-handler.js';

function routeApp(service: Partial<FirstImportService>, capabilities: readonly ('read' | 'write')[] = ['read', 'write']) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenantId = randomUUID();
    req.apiKeyId = randomUUID();
    req.apiCapabilities = capabilities;
    next();
  });
  app.use('/api/v1/first-imports', createFirstImportRoutes(service as FirstImportService));
  app.use(errorHandler);
  return app;
}

const discovery = {
  manifestPath: '/private/first-import/pending.json',
  sources: [{
    sourceId: 'codex',
    label: 'Codex',
    paths: ['/Users/local/.codex/sessions'],
    estimatedCount: 1,
    estimatedBytes: 120,
    privacyPosture: 'Only local transcript files selected after approval are read.',
    exclusions: ['prompt history', 'logs'],
    availability: 'available',
    availabilityNote: 'Local source history is available for selection.',
    items: [{
      fingerprint: 'a'.repeat(64),
      sourcePath: '/Users/local/.codex/sessions/rollout.jsonl',
      byteSize: 120,
      modifiedAt: '2026-08-14T12:00:00.000Z',
    }],
  }],
};

describe('first import routes', () => {
  it('validates discovery registration and passes tenant identity to the service', async () => {
    const registerDiscovery = vi.fn().mockResolvedValue({ id: randomUUID(), status: 'discovered' });
    const response = await request(routeApp({ registerDiscovery }))
      .post('/api/v1/first-imports')
      .send(discovery);

    expect(response.status).toBe(201);
    expect(registerDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: expect.any(String) }),
      discovery,
    );
  });

  it('rejects progress before it reaches the service when the runtime contract is unsafe', async () => {
    const recordEvent = vi.fn();
    const response = await request(routeApp({ recordEvent }))
      .post(`/api/v1/first-imports/${randomUUID()}/events`)
      .send({ sourceId: 'codex', fingerprint: 'not-a-fingerprint', outcome: 'imported' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('requires write capability for approval while allowing read-only status checks', async () => {
    const latest = vi.fn().mockResolvedValue(null);
    const approve = vi.fn();
    const app = routeApp({ latest, approve }, ['read']);

    expect((await request(app).get('/api/v1/first-imports/latest')).status).toBe(200);
    expect((await request(app).post(`/api/v1/first-imports/${randomUUID()}/approve`).send({ sourceIds: ['codex'] })).status).toBe(403);
    expect(approve).not.toHaveBeenCalled();
  });
});
