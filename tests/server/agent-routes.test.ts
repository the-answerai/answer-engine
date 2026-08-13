import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../../src/middleware/error-handler.js';
import { createAgentRoutes } from '../../src/routes/agent-routes.js';
import type { ContentService } from '../../src/services/content/content-service.js';

function routeApp(service: Partial<ContentService>, capabilities: readonly ('read' | 'write')[]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenantId = randomUUID();
    req.apiKeyId = randomUUID();
    req.apiCapabilities = capabilities;
    next();
  });
  app.use('/api/v1/agent', createAgentRoutes(service as ContentService));
  app.use(errorHandler);
  return app;
}

describe('agent routes', () => {
  it('requires read capability for retrieval operations', async () => {
    const query = vi.fn();
    const response = await request(routeApp({ query }, ['write']))
      .post('/api/v1/agent/query')
      .send({ query: 'architecture decisions' });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
    expect(query).not.toHaveBeenCalled();
  });
});
