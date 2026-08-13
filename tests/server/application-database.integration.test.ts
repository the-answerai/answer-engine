import { createHash, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { createApp } from '../../src/app.js';
import type { LanguageProvider } from '../../src/services/ai/openai-compatible.js';
import { LocalApplicationWorker } from '../../src/services/application/local-application-worker.js';

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === 'true' ? describe : describe.skip;
const { Pool } = pg;

describeDatabase('neutral application real-database workflows', () => {
  const pool = new Pool({
    host: process.env.DATABASE_HOST ?? '127.0.0.1',
    port: Number(process.env.DATABASE_PORT ?? 5433),
    database: process.env.DATABASE_NAME ?? 'answerengine',
    user: process.env.DATABASE_USER ?? 'postgres',
    password: process.env.DATABASE_PASSWORD ?? 'postgres',
  });
  const tenantId = randomUUID();
  const systemLibraryId = randomUUID();
  const apiKeyId = randomUUID();
  const apiKey = `ae_live_${randomBytes(32).toString('base64url')}`;
  const contentId = randomUUID();
  const otherContentId = randomUUID();
  const otherTenantId = randomUUID();
  const otherLibraryId = randomUUID();
  const language: LanguageProvider = {
    embed: vi.fn().mockResolvedValue([]),
    complete: vi.fn().mockImplementation(async (input: { prompt: string }) => ({
      text: input.prompt.includes('Evidence:') ? 'Grounded report [1]' : 'Grounded output [1]',
      model: 'local-test-model',
      provider: 'local-test',
    })),
  };

  beforeAll(async () => {
    await pool.query(
      `INSERT INTO tenants (id,name,slug) VALUES ($1,'Integration tenant',$2),($3,'Other tenant',$4)`,
      [tenantId, `integration-${tenantId}`, otherTenantId, `other-${otherTenantId}`],
    );
    await pool.query(
      `INSERT INTO libraries (id,tenant_id,name,slug,kind)
       VALUES ($1,$2,'All content',$3,'system_all_content'),
              ($4,$5,'Other all content',$6,'system_all_content')`,
      [systemLibraryId, tenantId, `all-${tenantId}`, otherLibraryId, otherTenantId, `all-${otherTenantId}`],
    );
    await pool.query(
      `INSERT INTO api_keys (id,tenant_id,key_hash,key_prefix,name)
       VALUES ($1,$2,$3,$4,'Integration key')`,
      [apiKeyId, tenantId, createHash('sha256').update(apiKey).digest('hex'), apiKey.slice(0, 16)],
    );
    await pool.query(
      `INSERT INTO content_items (
         id,tenant_id,library_id,content_type,source,source_identifier,title,content
       ) VALUES ($1,$2,$3,'document','local',$4,'Durable architecture note',
                 'The answer engine preserves tenant scoped evidence.'),
                ($5,$6,$7,'document','local',$8,'Other tenant secret','Must stay isolated')`,
      [contentId, tenantId, systemLibraryId, `integration:${contentId}`,
        otherContentId, otherTenantId, otherLibraryId, `other:${randomUUID()}`],
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])', [[tenantId, otherTenantId]]);
    await pool.end();
  });

  it('runs CRUD, scoped membership, grounded answers, workers, tokens, and audit end to end', async () => {
    const app = createApp({ dependencies: { database: pool, languageProvider: language } });
    const authenticated = (method: 'get' | 'post' | 'put' | 'delete' | 'patch', path: string) =>
      request(app)[method](path).set('X-API-Key', apiKey);

    const tagResponse = await authenticated('post', '/api/v1/tags')
      .send({ slug: 'architecture', label: 'Architecture' });
    expect(tagResponse.status).toBe(201);
    const tagId = tagResponse.body.data.id as string;

    const assignment = await authenticated('post', `/api/v1/tags/${tagId}/content`)
      .send({ contentIds: [contentId] });
    expect(assignment.body.data.changed).toBe(1);

    const libraryResponse = await authenticated('post', '/api/v1/libraries').send({
      name: 'Architecture notes',
      slug: `architecture-${tenantId.slice(0, 8)}`,
      filter: {
        operator: 'and',
        conditions: [{ field: 'tag', operator: 'in', value: ['architecture'] }],
      },
    });
    expect(libraryResponse.status).toBe(201);
    const libraryId = libraryResponse.body.data.id as string;

    const initialMembers = await authenticated('get', `/api/v1/libraries/${libraryId}/members`);
    expect(initialMembers.body.data.items.map((item: { id: string }) => item.id)).toEqual([contentId]);

    await authenticated('put', `/api/v1/libraries/${libraryId}/excludes/${contentId}`);
    await authenticated('put', `/api/v1/libraries/${libraryId}/includes/${contentId}`);
    const excludedMembers = await authenticated('get', `/api/v1/libraries/${libraryId}/members`);
    expect(excludedMembers.body.data.items).toEqual([]);
    await authenticated('delete', `/api/v1/libraries/${libraryId}/excludes/${contentId}`);

    const queryResponse = await authenticated('post', '/api/v1/agent/query').send({
      query: 'tenant scoped evidence', searchType: 'fulltext', libraryId,
    });
    expect(queryResponse.body.data.results[0].id).toBe(contentId);
    const askResponse = await authenticated('post', '/api/v1/agent/ask').send({
      question: 'What does the engine preserve?', retrievalMode: 'fulltext', libraryId,
    });
    expect(askResponse.body.data.citations[0].contentId).toBe(contentId);

    const recipeResponse = await authenticated('post', `/api/v1/libraries/${libraryId}/recipes`).send({
      name: 'Extract insight', contentTypes: ['document'],
      systemPrompt: 'Extract one grounded insight.',
      userPromptTemplate: 'Analyze {{content}}', outputType: 'recipe_insight',
    });
    expect(recipeResponse.status).toBe(201);
    const recipeId = recipeResponse.body.data.id as string;
    const runResponse = await authenticated('post', `/api/v1/libraries/${libraryId}/recipes/${recipeId}/runs`);
    const runId = runResponse.body.data.id as string;
    const worker = new LocalApplicationWorker(pool, language);
    expect(await worker.runNext()).toBe('recipe');
    const run = await authenticated('get', `/api/v1/libraries/${libraryId}/runs/${runId}`);
    expect(run.body.data).toMatchObject({ status: 'succeeded', succeededCount: 1 });
    expect(run.body.data.items[0].artifactId).toEqual(expect.any(String));
    const canceledRun = await authenticated('post', `/api/v1/libraries/${libraryId}/recipes/${recipeId}/runs`);
    await authenticated('post', `/api/v1/libraries/${libraryId}/runs/${canceledRun.body.data.id}/cancel`);
    const retriedRun = await authenticated('post', `/api/v1/libraries/${libraryId}/runs/${canceledRun.body.data.id}/retry`);
    expect(retriedRun.status).toBe(202);
    expect(await worker.runNext()).toBe('recipe');

    const reportResponse = await authenticated('post', `/api/v1/libraries/${libraryId}/reports`).send({
      title: 'Architecture wiki', slug: 'architecture-wiki', prompt: 'Summarize the architecture.',
    });
    const reportId = reportResponse.body.data.id as string;
    const canceledReport = await authenticated('post', `/api/v1/libraries/${libraryId}/reports/${reportId}/generate`);
    await authenticated('post', `/api/v1/libraries/${libraryId}/reports/${reportId}/generated/${canceledReport.body.data.id}/cancel`);
    const retriedReport = await authenticated('post', `/api/v1/libraries/${libraryId}/reports/${reportId}/generated/${canceledReport.body.data.id}/retry`);
    expect(retriedReport.status).toBe(202);
    expect(await worker.runNext()).toBe('report');
    const reports = await authenticated('get', `/api/v1/libraries/${libraryId}/reports/${reportId}/generated`);
    expect(reports.body.data[0]).toMatchObject({ status: 'succeeded', body: 'Grounded report [1]' });

    const dashboard = await authenticated('post', `/api/v1/libraries/${libraryId}/dashboards`).send({
      name: 'Local overview', widgets: [{ type: 'count' }],
    });
    expect(dashboard.status).toBe(201);

    const canceledBatch = await authenticated('post', '/api/v1/batch-jobs').send({
      libraryId, kind: 'prompt', name: 'Batch insight', contentIds: [contentId],
      input: { prompt: 'Summarize this item.' },
    });
    await authenticated('post', `/api/v1/batch-jobs/${canceledBatch.body.data.id}/cancel`);
    const batch = await authenticated('post', `/api/v1/batch-jobs/${canceledBatch.body.data.id}/retry`);
    expect(batch.status).toBe(202);
    expect(await worker.runNext()).toBe('batch');
    const batchDetail = await authenticated('get', `/api/v1/batch-jobs/${batch.body.data.id}`);
    expect(batchDetail.body.data).toMatchObject({ status: 'succeeded', succeededCount: 1 });

    const token = await authenticated('post', '/api/v1/access-tokens').send({
      name: 'Architecture reader', libraryId, capabilities: ['read'],
    });
    expect(token.body.data.token).toMatch(/^ae_live_/);
    const scopedContent = await request(app).get(`/api/v1/content/${contentId}`)
      .set('X-API-Key', token.body.data.token);
    expect(scopedContent.status).toBe(200);
    const isolatedContent = await request(app).get(`/api/v1/content/${otherContentId}`)
      .set('X-API-Key', token.body.data.token);
    expect(isolatedContent.status).toBe(404);
    const readOnlyMutation = await request(app).post('/api/v1/tags')
      .set('X-API-Key', token.body.data.token)
      .send({ slug: 'blocked-write', label: 'Blocked write' });
    expect(readOnlyMutation.status).toBe(403);
    const tokenList = await authenticated('get', '/api/v1/access-tokens');
    expect(tokenList.body.data.find((item: { id: string }) => item.id === token.body.data.id)).not.toHaveProperty('token');
    await authenticated('delete', `/api/v1/access-tokens/${token.body.data.id}`);
    const revoked = await request(app).get(`/api/v1/content/${contentId}`)
      .set('X-API-Key', token.body.data.token);
    expect(revoked.status).toBe(401);

    const audit = await authenticated('get', `/api/v1/audit?libraryId=${libraryId}&limit=100`);
    expect(audit.body.data.items.map((item: { action: string }) => item.action)).toEqual(
      expect.arrayContaining(['library.create', 'recipe.run', 'report.generate', 'dashboard.create']),
    );

    const persisted = await pool.query('SELECT id FROM content_items WHERE tenant_id=$1 AND id=$2', [tenantId, contentId]);
    expect(persisted.rows).toHaveLength(1);
  }, 60_000);
});
