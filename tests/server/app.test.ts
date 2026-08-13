import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import type { Database } from '../../src/config/database.js';
import type { LanguageProvider } from '../../src/services/ai/openai-compatible.js';

const database = { query: vi.fn(), connect: vi.fn() } as unknown as Database;
const languageProvider: LanguageProvider = {
  embed: vi.fn(),
  complete: vi.fn(),
};

describe('createApp local defaults', () => {
  it('exposes a public health check without contacting external services', async () => {
    const response = await request(createApp({ dependencies: { database, languageProvider } })).get('/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('healthy');
  });

  it('protects all v1 endpoints with local API-key authentication', async () => {
    const response = await request(createApp({ dependencies: { database, languageProvider } })).get('/api/v1/agent/schema');
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
  });

  it('accepts large lineage envelopes produced by real history imports', async () => {
    const app = createApp({
      dependencies: { database, languageProvider },
      extensions: {
        registerPublicRoutes: (router) => {
          router.post('/test-large-lineage', (req, res) => {
            res.json({ bytes: Buffer.byteLength(req.body.lineage as string) });
          });
        },
      },
    });
    const lineage = 'x'.repeat(11 * 1024 * 1024);

    const response = await request(app).post('/test-large-lineage').send({ lineage });

    expect(response.status).toBe(200);
    expect(response.body.bytes).toBe(Buffer.byteLength(lineage));
  });

  it('composes named extension capabilities, routes, and authentication policy', async () => {
    const app = createApp({
      dependencies: { database, languageProvider },
      extensions: {
        capabilities: [{ id: 'example.manage', label: 'Example management', family: 'teams' }],
        routes: [
          { id: 'example.status', method: 'GET', path: '/example/status', access: 'public' },
          { id: 'example.manage', method: 'GET', path: '/api/v1/example', access: 'authenticated', capabilityId: 'example.manage' },
        ],
        authentication: (req, _res, next) => {
          req.auth = { tenantId: crypto.randomUUID(), apiKeyId: crypto.randomUUID() };
          next();
        },
        registerPublicRoutes: (router) => {
          router.get('/example/status', (_req, res) => res.json({ status: 'fixture-ready' }));
        },
        registerAuthenticatedRoutes: (router) => {
          router.get('/api/v1/example', (_req, res) => res.json({ allowed: true }));
        },
      },
    });

    expect((await request(app).get('/example/status')).body.status).toBe('fixture-ready');
    expect((await request(app).get('/api/v1/example')).body.allowed).toBe(true);
  });

  it('rejects extension metadata that shadows an OSS-owned route', () => {
    expect(() => createApp({
      dependencies: { database, languageProvider },
      extensions: {
        routes: [{ id: 'fixture.shadow', method: 'GET', path: '/api/v1/content', access: 'authenticated' }],
      },
    })).toThrow('conflicts with an OSS core route');
  });
});
