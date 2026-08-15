import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../../src/middleware/error-handler.js';
import { createOrganizationRoutes } from '../../src/routes/organization-routes.js';
import type { OrganizationService } from '../../src/services/organization/organization-service.js';

function routeApp(
  service: Partial<OrganizationService>,
  capabilities: readonly ('read' | 'write')[] = ['read', 'write'],
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenantId = randomUUID(); req.apiKeyId = randomUUID(); req.apiCapabilities = capabilities; next();
  });
  app.use('/api/v1/organization-plans', createOrganizationRoutes(service as OrganizationService));
  app.use(errorHandler);
  return app;
}

describe('organization routes', () => {
  it('requires write capability to persist a proposal and validates bounded input', async () => {
    const createProposal = vi.fn();
    const readOnly = await request(routeApp({ createProposal }, ['read']))
      .post('/api/v1/organization-plans').send({ useModel: false, limit: 50 });
    const invalid = await request(routeApp({ createProposal }))
      .post('/api/v1/organization-plans').send({ useModel: false, limit: 10_000 });

    expect(readOnly.status).toBe(403);
    expect(invalid.status).toBe(400);
    expect(createProposal).not.toHaveBeenCalled();
  });

  it('allows read inspection but requires complete typed decisions for apply', async () => {
    const planId = randomUUID();
    const getPlan = vi.fn().mockResolvedValue({ id: planId, status: 'preview' });
    const applyPlan = vi.fn();
    const app = routeApp({ getPlan, applyPlan });

    const read = await request(app).get(`/api/v1/organization-plans/${planId}`);
    const invalid = await request(app).post(`/api/v1/organization-plans/${planId}/apply`)
      .send({ decisions: [{ suggestionId: 'unsafe', decision: 'accept' }] });

    expect(read.status).toBe(200);
    expect(invalid.status).toBe(400);
    expect(applyPlan).not.toHaveBeenCalled();
  });

  it('requires write capability for apply and undo', async () => {
    const planId = randomUUID();
    const applyPlan = vi.fn(); const undoPlan = vi.fn();
    const app = routeApp({ applyPlan, undoPlan }, ['read']);

    expect((await request(app).post(`/api/v1/organization-plans/${planId}/apply`).send({ decisions: [] })).status).toBe(403);
    expect((await request(app).post(`/api/v1/organization-plans/${planId}/undo`)).status).toBe(403);
    expect(applyPlan).not.toHaveBeenCalled(); expect(undoPlan).not.toHaveBeenCalled();
  });
});
