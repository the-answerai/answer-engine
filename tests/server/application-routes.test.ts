import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { errorHandler } from '../../src/middleware/error-handler.js';
import { createApplicationRoutes } from '../../src/routes/application-routes.js';
import type { ApplicationService } from '../../src/services/application/application-service.js';
import type { Database } from '../../src/config/database.js';
import type { LanguageProvider } from '../../src/services/ai/openai-compatible.js';

function routeApp(service: Partial<ApplicationService>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenantId = randomUUID();
    req.apiKeyId = randomUUID();
    next();
  });
  app.use('/api/v1', createApplicationRoutes(service as ApplicationService));
  app.use(errorHandler);
  return app;
}

describe('neutral application routes', () => {
  it('validates and creates a tenant-scoped tag', async () => {
    const createTag = vi.fn().mockResolvedValue({ id: randomUUID(), slug: 'local-history' });
    const response = await request(routeApp({ createTag }))
      .post('/api/v1/tags')
      .send({ slug: 'local-history', label: 'Local history' });

    expect(response.status).toBe(201);
    expect(response.body.data.slug).toBe('local-history');
    expect(createTag).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: expect.any(String), apiKeyId: expect.any(String) }),
      expect.objectContaining({ slug: 'local-history', metadata: {} }),
    );
  });

  it('rejects unknown library filter fields before persistence', async () => {
    const previewLibrary = vi.fn();
    const response = await request(routeApp({ previewLibrary }))
      .post(`/api/v1/libraries/${randomUUID()}/preview`)
      .send({
        filter: {
          operator: 'and',
          conditions: [{ field: 'owner_id', operator: 'eq', value: 'hidden' }],
        },
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(previewLibrary).not.toHaveBeenCalled();
  });

  it('rejects untyped dashboard widgets before persistence', async () => {
    const createDashboard = vi.fn();
    const response = await request(routeApp({ createDashboard }))
      .post(`/api/v1/libraries/${randomUUID()}/dashboards`)
      .send({ name: 'Unsafe view', widgets: [{ type: 'remote-script', config: { url: 'https://example.com' } }] });

    expect(response.status).toBe(400);
    expect(createDashboard).not.toHaveBeenCalled();
  });

  it('returns a newly minted access token only from the creation response', async () => {
    const rawToken = 'ae_live_creation_only_secret';
    const createAccessToken = vi.fn().mockResolvedValue({
      id: randomUUID(), keyPrefix: 'ae_live_creation', token: rawToken,
    });
    const response = await request(routeApp({ createAccessToken }))
      .post('/api/v1/access-tokens')
      .send({ name: 'Local automation', capabilities: ['read'] });

    expect(response.status).toBe(201);
    expect(response.body.data.token).toBe(rawToken);
  });

  it('reads and validates local-owner settings without accepting unknown or secret fields', async () => {
    const settings = {
      defaultPageSize: 50,
      defaultLibraryId: null,
      density: 'compact',
      defaultExportFormat: 'json',
    };
    const getSettings = vi.fn().mockResolvedValue(settings);
    const updateSettings = vi.fn().mockResolvedValue(settings);
    const app = routeApp({ getSettings, updateSettings });

    const getResponse = await request(app).get('/api/v1/settings');
    const invalidResponse = await request(app)
      .patch('/api/v1/settings')
      .send({ providerApiKey: 'must-not-be-accepted' });
    const patchResponse = await request(app)
      .patch('/api/v1/settings')
      .send({ defaultPageSize: 50, density: 'compact' });

    expect(getResponse.status).toBe(200);
    expect(getResponse.body.data).toEqual(settings);
    expect(invalidResponse.status).toBe(400);
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: expect.any(String) }),
      { defaultPageSize: 50, density: 'compact' },
    );
    expect(patchResponse.body.data).toEqual(settings);
  });

  it('returns a conflict response for database integrity violations', async () => {
    const conflict = Object.assign(new Error('duplicate key value'), { code: '23505' });
    const createTag = vi.fn().mockRejectedValue(conflict);
    const response = await request(routeApp({ createTag }))
      .post('/api/v1/tags')
      .send({ slug: 'duplicate', label: 'Duplicate' });

    expect(response.status).toBe(409);
    expect(response.body.error).toMatchObject({ code: 'CONFLICT', statusCode: 409 });
    expect(response.body.error.message).not.toContain('duplicate key');
  });

  it('advertises all neutral endpoint families without paid-only concepts', async () => {
    const database = { query: vi.fn(), connect: vi.fn() } as unknown as Database;
    const languageProvider: LanguageProvider = { embed: vi.fn(), complete: vi.fn() };
    const response = await request(createApp({
      dependencies: { database, languageProvider },
      extensions: {
        authentication: (req, _res, next) => {
          req.tenantId = randomUUID();
          req.apiKeyId = randomUUID();
          next();
        },
      },
    })).get('/api/v1');

    expect(response.status).toBe(200);
    expect(Object.keys(response.body.endpoints)).toEqual(expect.arrayContaining([
      'content', 'agent', 'tags', 'libraries', 'batchJobs', 'accessTokens', 'audit', 'settings',
    ]));
    expect(JSON.stringify(response.body)).not.toMatch(/rbac|billing|permissions|teams|roles/i);
  });
});
