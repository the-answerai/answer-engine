import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createContentRoutes } from '../../src/routes/content-routes.js';
import type { ContentService } from '../../src/services/content/content-service.js';
import { errorHandler } from '../../src/middleware/error-handler.js';

function routeApp(service: Partial<ContentService>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenantId = randomUUID();
    req.apiKeyId = randomUUID();
    next();
  });
  app.use('/api/v1/content', createContentRoutes(service as ContentService));
  app.use(errorHandler);
  return app;
}

describe('content workspace list route', () => {
  it('normalizes filters and sort options before calling the service', async () => {
    const list = vi.fn().mockResolvedValue({
      items: [],
      meta: { hasMore: false, nextCursor: null, total: 0 },
    });

    const response = await request(routeApp({ list }))
      .get('/api/v1/content')
      .query({
        limit: '25',
        search: 'agent history',
        contentTypes: 'chat,document',
        sources: 'claude-code,codex,cowork',
        tags: 'history,decision',
        status: 'active',
        sortBy: 'source',
        sortDirection: 'asc',
      });

    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: expect.any(String) }),
      expect.objectContaining({
        limit: 25,
        search: 'agent history',
        contentTypes: ['chat', 'document'],
        sources: ['claude-code', 'codex', 'cowork'],
        tags: ['history', 'decision'],
        status: 'active',
        sortBy: 'source',
        sortDirection: 'asc',
      }),
    );
  });

  it('rejects unsupported sort fields at the runtime boundary', async () => {
    const list = vi.fn();

    const response = await request(routeApp({ list }))
      .get('/api/v1/content?sortBy=tenantId');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(list).not.toHaveBeenCalled();
  });
});
