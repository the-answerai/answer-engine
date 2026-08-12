import { createHash, randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../src/config/database.js';
import { createApiKeyAuth } from '../../src/middleware/api-key-auth.js';
import { createLocalUiSessionCookie } from '../../src/middleware/local-ui-session.js';
import { errorHandler } from '../../src/middleware/error-handler.js';

function createDatabase(apiKey: string) {
  const tenantId = randomUUID();
  const keyId = randomUUID();
  const keyHash = createHash('sha256').update(apiKey).digest('hex');
  const query = vi.fn()
    .mockResolvedValueOnce({
      rows: [{ id: keyId, tenant_id: tenantId, library_id: null, key_hash: keyHash }],
    })
    .mockResolvedValueOnce({ rows: [], rowCount: 1 });
  return { keyHash, query, tenantId };
}

function testApp(apiKey: string, query: ReturnType<typeof vi.fn>) {
  const app = express();
  app.get(
    '/local-ui/session',
    createLocalUiSessionCookie(apiKey),
    (_req, res) => res.status(204).end(),
  );
  app.use('/api/v1', createApiKeyAuth(
    { query } as unknown as Database,
    { localUiApiKey: apiKey },
  ));
  app.get('/api/v1/protected', (req, res) => res.json({ tenantId: req.tenantId }));
  app.use(errorHandler);
  return app;
}

describe('local UI session authentication', () => {
  it('authorizes a same-origin browser session without exposing the API key', async () => {
    const apiKey = `ae_live_${randomUUID().replaceAll('-', '')}`;
    const { keyHash, query, tenantId } = createDatabase(apiKey);
    const app = testApp(apiKey, query);

    const bootstrap = await request(app)
      .get('/local-ui/session')
      .set('Sec-Fetch-Site', 'same-origin');
    const setCookie = bootstrap.headers['set-cookie']?.[0];

    expect(setCookie).toBeDefined();
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/api/v1');
    expect(setCookie).not.toContain(apiKey);

    const cookie = setCookie?.split(';')[0] ?? '';
    const response = await request(app)
      .get('/api/v1/protected')
      .set('Cookie', cookie)
      .set('Sec-Fetch-Site', 'same-origin');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ tenantId });
    expect(query.mock.calls[0]?.[1]).toEqual([keyHash]);
  });

  it('rejects the local UI cookie on cross-origin requests', async () => {
    const apiKey = `ae_live_${randomUUID().replaceAll('-', '')}`;
    const query = vi.fn();
    const app = testApp(apiKey, query);
    const bootstrap = await request(app)
      .get('/local-ui/session')
      .set('Sec-Fetch-Site', 'same-origin');
    const cookie = bootstrap.headers['set-cookie']?.[0]?.split(';')[0] ?? '';

    const response = await request(app)
      .get('/api/v1/protected')
      .set('Cookie', cookie)
      .set('Sec-Fetch-Site', 'cross-site');

    expect(response.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses to issue a local UI session to a cross-origin request', async () => {
    const apiKey = `ae_live_${randomUUID().replaceAll('-', '')}`;
    const query = vi.fn();
    const response = await request(testApp(apiKey, query))
      .get('/local-ui/session')
      .set('Sec-Fetch-Site', 'cross-site');

    expect(response.status).toBe(403);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  it('keeps direct API requests without credentials unauthorized', async () => {
    const apiKey = `ae_live_${randomUUID().replaceAll('-', '')}`;
    const query = vi.fn();
    const response = await request(testApp(apiKey, query)).get('/api/v1/protected');

    expect(response.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });
});
