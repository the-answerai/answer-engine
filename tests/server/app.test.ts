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
});
