import { createHash, randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../src/config/database.js';
import { createApiKeyAuth } from '../../src/middleware/api-key-auth.js';
import { errorHandler } from '../../src/middleware/error-handler.js';

function testApp(query: ReturnType<typeof vi.fn>) {
  const app = express();
  app.use(createApiKeyAuth({ query } as unknown as Database));
  app.get('/protected', (req, res) => res.json({ tenantId: req.tenantId }));
  app.use(errorHandler);
  return app;
}

describe('API key authentication', () => {
  it('rejects bearer credentials outside the local API-key namespace without querying the database', async () => {
    const query = vi.fn();
    const response = await request(testApp(query))
      .get('/protected')
      .set('Authorization', 'Bearer opaque-session-token');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
    expect(query).not.toHaveBeenCalled();
  });

  it('resolves the tenant from a valid hashed local API key', async () => {
    const tenantId = randomUUID();
    const keyId = randomUUID();
    const apiKey = `ae_live_${randomUUID().replaceAll('-', '')}`;
    const keyHash = createHash('sha256').update(apiKey).digest('hex');
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: keyId, tenant_id: tenantId, library_id: null, key_hash: keyHash }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const response = await request(testApp(query)).get('/protected').set('X-API-Key', apiKey);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ tenantId });
    expect(query.mock.calls[0]?.[1]).toEqual([keyHash]);
    expect(query.mock.calls[1]?.[1]).toEqual([tenantId, keyId]);
  });
});
