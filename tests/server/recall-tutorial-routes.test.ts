import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../../src/middleware/error-handler.js';
import { createRecallTutorialRoutes } from '../../src/routes/recall-tutorial-routes.js';
import type { RecallTutorialService } from '../../src/services/recall-tutorial/recall-tutorial-service.js';

function appFor(service: Partial<RecallTutorialService>, capabilities: readonly ('read' | 'write')[] = ['read', 'write']) {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.tenantId = randomUUID(); request.apiKeyId = randomUUID();
    request.apiCapabilities = capabilities; request.apiSurface = 'browser'; next();
  });
  app.use('/api/v1/recall-tutorials', createRecallTutorialRoutes(service as RecallTutorialService));
  app.use(errorHandler);
  return app;
}

describe('recall tutorial routes', () => {
  it('returns capability preflight with read access', async () => {
    const capabilities = vi.fn().mockReturnValue([{ id: 'codex', supported: true }]);
    const response = await request(appFor({ capabilities }, ['read']))
      .get('/api/v1/recall-tutorials/capabilities?environment=wsl');
    expect(response.status).toBe(200);
    expect(capabilities).toHaveBeenCalledWith('wsl');
  });

  it('requires write access and strict client input to create a challenge', async () => {
    const create = vi.fn();
    const readOnly = await request(appFor({ create }, ['read']))
      .post('/api/v1/recall-tutorials').send({ writeClient: 'codex', recallClient: 'claude-code' });
    const invalid = await request(appFor({ create }))
      .post('/api/v1/recall-tutorials').send({ writeClient: 'unknown', recallClient: 'codex' });
    expect(readOnly.status).toBe(403);
    expect(invalid.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it('validates IDs and diagnostic reports before checking proof', async () => {
    const check = vi.fn().mockResolvedValue({ id: randomUUID(), status: 'remembered' });
    const app = appFor({ check });
    expect((await request(app).post('/api/v1/recall-tutorials/not-a-uuid/check').send({})).status).toBe(400);
    expect((await request(app).post(`/api/v1/recall-tutorials/${randomUUID()}/check`).send({ reportedFailure: 'secret' })).status).toBe(400);
    expect(check).not.toHaveBeenCalled();
  });
});
