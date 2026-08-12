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
});
