import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { identifyRequestSurface } from '../../src/middleware/request-surface.js';

describe('request surface identification', () => {
  const app = express().use(identifyRequestSurface).get('/', (req, res) => res.json({ surface: req.apiSurface, client: req.apiClient }));

  it('accepts only known tool surfaces and treats untrusted values as API', async () => {
    expect((await request(app).get('/').set('X-AE-Surface', 'mcp')).body.surface).toBe('mcp');
    expect((await request(app).get('/').set('X-AE-Surface', 'mcp-spoof')).body.surface).toBe('api');
    expect((await request(app).get('/').set('X-AE-Surface', 'unknown')).body.surface).toBe('api');
  });

  it('records only known client identities compatible with their transport', async () => {
    expect((await request(app).get('/').set('X-AE-Surface', 'mcp').set('X-AE-Client', 'claude-code')).body.client).toBe('claude-code');
    expect((await request(app).get('/').set('X-AE-Surface', 'cli').set('X-AE-Client', 'cli')).body.client).toBe('cli');
    expect((await request(app).get('/').set('X-AE-Surface', 'mcp').set('X-AE-Client', 'cli')).body.client).toBeUndefined();
    expect((await request(app).get('/').set('X-AE-Surface', 'mcp').set('X-AE-Client', 'forged')).body.client).toBeUndefined();
  });

  it('identifies same-origin browser requests without trusting arbitrary headers', async () => {
    expect((await request(app).get('/').set('Sec-Fetch-Site', 'same-origin')).body.surface).toBe('browser');
    const spoof = (await request(app).get('/')
      .set('Sec-Fetch-Site', 'same-origin').set('X-AE-Surface', 'mcp').set('X-AE-Client', 'codex')).body;
    expect(spoof).toEqual({ surface: 'browser' });
  });
});
