import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../src/config/database.js';
import type { LanguageProvider } from '../../src/services/ai/openai-compatible.js';
import { OrganizationService } from '../../src/services/organization/organization-service.js';

const tenantId = randomUUID();
const apiKeyId = randomUUID();
const firstId = randomUUID();
const secondId = randomUUID();
const tagId = randomUUID();
const libraryId = randomUUID();
const planId = randomUUID();
const now = new Date('2026-08-15T20:00:00.000Z');

function contentRows(updatedAt = now) {
  return [
    { id: firstId, title: 'Codex planning', summary: 'A bounded summary', source: 'codex', contentType: 'chat', updatedAt, tagSlugs: [] },
    { id: secondId, title: 'Codex implementation', summary: 'Another summary', source: 'codex', contentType: 'chat', updatedAt, tagSlugs: [] },
  ];
}

function provider(text = '{"categories":[]}'): LanguageProvider {
  return { embed: vi.fn(), complete: vi.fn().mockResolvedValue({ text, model: 'local-model', provider: 'local' }) };
}

function proposalDatabase() {
  let record: Record<string, unknown> | undefined;
  const calls: Array<{ sql: string; parameters: unknown[] }> = [];
  const query = vi.fn(async (sql: string, parameters: unknown[] = []) => {
    calls.push({ sql, parameters });
    if (sql.includes('FROM content_items c') && sql.includes('ARRAY_AGG')) return { rows: contentRows(), rowCount: 2 };
    if (sql.includes('FROM tags') && sql.includes('ORDER BY slug')) return { rows: [], rowCount: 0 };
    if (sql.includes('FROM libraries') && sql.includes('ORDER BY slug')) return { rows: [], rowCount: 0 };
    if (sql.includes('INSERT INTO organization_plans')) {
      record = {
        id: planId, status: 'preview', proposal_mode: parameters[1], sample_limit: parameters[2],
        sample_count: parameters[3], source_snapshot_sha256: parameters[4], proposal_sha256: parameters[5],
        suggestions: parameters[6], decisions: null, apply_result: null,
        model_provider: parameters[7], model_id: parameters[8], applied_at: null, undone_at: null,
        created_at: now, updated_at: now,
      };
      return { rows: [record], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO audit_log')) return { rows: [], rowCount: 1 };
    throw new Error(`Unexpected query: ${sql}`);
  });
  return { database: { query } as unknown as Database, query, calls, record: () => record };
}

describe('OrganizationService', () => {
  it('creates a deterministic evidence-backed preview without mutating user data', async () => {
    const fake = proposalDatabase();
    const service = new OrganizationService(fake.database, provider());

    const plan = await service.createProposal({ tenantId, apiKeyId }, { useModel: false, limit: 50 });

    expect(plan.status).toBe('preview');
    expect(plan.suggestions.map((suggestion) => suggestion.type)).toEqual([
      'tag.create', 'tag.assign', 'library.create',
    ]);
    expect(plan.suggestions.every((suggestion) => suggestion.evidence.length > 0)).toBe(true);
    expect(plan.suggestions[1]?.dependsOn).toEqual([plan.suggestions[0]?.id]);
    const mutationSql = fake.calls.map((call) => call.sql)
      .filter((sql) => /(?:UPDATE|DELETE FROM)\s+(?:content_items|tags|libraries|content_tags)/i.test(sql));
    expect(mutationSql).toEqual([]);
    expect(fake.calls.find((call) => call.sql.includes('FROM content_items'))?.sql).not.toMatch(/c\.content(?:\s|,)/);
  });

  it('exposes only bounded metadata to an explicitly requested model and rejects invented IDs', async () => {
    const fake = proposalDatabase();
    const language = provider(JSON.stringify({ categories: [{
      slug: 'project-work', label: 'Project work', description: null,
      contentIds: [randomUUID()], confidence: 0.7, rationale: 'Related work', createLibrary: false,
    }] }));
    const service = new OrganizationService(fake.database, language);

    await expect(service.createProposal({ tenantId, apiKeyId }, { useModel: true, limit: 10 }))
      .rejects.toThrow(/outside the bounded proposal sample/i);

    const prompt = vi.mocked(language.complete).mock.calls[0]?.[0].prompt ?? '';
    expect(prompt).toContain('A bounded summary');
    expect(prompt).not.toContain('raw_archive_manifest');
    expect(fake.calls.some((call) => call.sql.includes('INSERT INTO organization_plans'))).toBe(false);
  });

  it('applies a complete accepted plan transactionally and undoes only introduced organization state', async () => {
    const fake = proposalDatabase();
    const service = new OrganizationService(fake.database, provider());
    const preview = await service.createProposal({ tenantId, apiKeyId }, { useModel: false, limit: 50 });
    let record = fake.record()!;
    let tagActive: boolean | undefined;
    let libraryActive: boolean | undefined;
    const transactionCalls: string[] = [];
    const transactionQuery = vi.fn(async (sql: string, parameters: unknown[] = []) => {
      transactionCalls.push(sql);
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: null };
      if (sql.includes('FROM organization_plans') && sql.includes('FOR UPDATE')) return { rows: [record], rowCount: 1 };
      if (sql.includes('FROM content_items c') && sql.includes('ARRAY_AGG')) return { rows: contentRows(), rowCount: 2 };
      if (sql.includes('FROM tags') && sql.includes('ORDER BY slug')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM libraries') && sql.includes('ORDER BY slug')) return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT id,is_active,metadata FROM tags')) {
        return tagActive === undefined
          ? { rows: [], rowCount: 0 }
          : { rows: [{ id: tagId, is_active: tagActive, metadata: { organizationPlanId: planId } }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO tags')) {
        tagActive = true;
        return { rows: [{ id: tagId, updated_at: now }], rowCount: 1 };
      }
      if (sql.includes('UPDATE tags SET is_active=true')) {
        tagActive = true;
        return { rows: [{ updated_at: now }], rowCount: 1 };
      }
      if (sql.includes('SELECT id FROM tags')) return { rows: [{ id: tagId }], rowCount: 1 };
      if (sql.includes('INSERT INTO content_tags')) return { rows: [{ content_id: firstId }, { content_id: secondId }], rowCount: 2 };
      if (sql.includes('SELECT id,is_active,metadata FROM libraries')) {
        return libraryActive === undefined
          ? { rows: [], rowCount: 0 }
          : { rows: [{ id: libraryId, is_active: libraryActive, metadata: { organizationPlanId: planId } }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO libraries')) {
        libraryActive = true;
        return { rows: [{ id: libraryId, updated_at: now }], rowCount: 1 };
      }
      if (sql.includes('UPDATE libraries SET is_active=true')) {
        libraryActive = true;
        return { rows: [{ updated_at: now }], rowCount: 1 };
      }
      if (sql.includes("SET status='applied'")) {
        record = { ...record, status: 'applied', decisions: parameters[2], apply_result: parameters[3], applied_at: now };
        return { rows: [record], rowCount: 1 };
      }
      if (sql.includes('DELETE FROM content_tags')) return { rows: [], rowCount: 2 };
      if (sql.includes('UPDATE tags SET is_active=false')) {
        tagActive = false;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE libraries SET is_active=false')) {
        libraryActive = false;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("SET status='undone'")) {
        record = { ...record, status: 'undone', undone_at: now };
        return { rows: [record], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO audit_log')) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected transaction query: ${sql}`);
    });
    const client = { query: transactionQuery, release: vi.fn() };
    (fake.database as Database).connect = vi.fn().mockResolvedValue(client) as Database['connect'];
    const decisions = preview.suggestions.map((suggestion) => ({
      suggestionId: suggestion.id,
      decision: 'accept' as const,
    }));

    const applied = await service.applyPlan({ tenantId, apiKeyId }, planId, { decisions });
    const undone = await service.undoPlan({ tenantId, apiKeyId }, planId);
    const reapplied = await service.applyPlan({ tenantId, apiKeyId }, planId, { decisions });
    const reundone = await service.undoPlan({ tenantId, apiKeyId }, planId);

    expect(applied.status).toBe('applied');
    expect(undone.status).toBe('undone');
    expect(reapplied.status).toBe('applied');
    expect(reapplied.applyResult).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tag.create', reactivated: true }),
      expect.objectContaining({ type: 'library.create', reactivated: true }),
    ]));
    expect(reundone.status).toBe('undone');
    expect(transactionCalls.filter((sql) => sql === 'COMMIT')).toHaveLength(4);
    expect(transactionCalls.filter((sql) => sql.includes('INSERT INTO tags'))).toHaveLength(1);
    expect(transactionCalls.filter((sql) => sql.includes('INSERT INTO libraries'))).toHaveLength(1);
    expect(transactionCalls.some((sql) => /DELETE FROM content_items/i.test(sql))).toBe(false);
    expect(transactionCalls.some((sql) => sql.includes("metadata->>'organizationPlanId'"))).toBe(true);
  });

  it('rolls back an incomplete decision set and a stale source snapshot', async () => {
    const fake = proposalDatabase();
    const service = new OrganizationService(fake.database, provider());
    const preview = await service.createProposal({ tenantId, apiKeyId }, { useModel: false, limit: 50 });
    const record = fake.record()!;
    let changed = false;
    const transactionQuery = vi.fn(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [], rowCount: null };
      if (sql.includes('FROM organization_plans')) return { rows: [record], rowCount: 1 };
      if (sql.includes('FROM content_items c')) return { rows: contentRows(changed ? new Date(now.getTime() + 1_000) : now), rowCount: 2 };
      if (sql.includes('FROM tags')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM libraries')) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected query: ${sql}`);
    });
    (fake.database as Database).connect = vi.fn().mockResolvedValue({ query: transactionQuery, release: vi.fn() }) as Database['connect'];

    await expect(service.applyPlan({ tenantId, apiKeyId }, planId, {
      decisions: [{ suggestionId: preview.suggestions[0]!.id, decision: 'accept' }],
    })).rejects.toThrow(/every organization suggestion/i);
    changed = true;
    await expect(service.applyPlan({ tenantId, apiKeyId }, planId, {
      decisions: preview.suggestions.map((suggestion) => ({ suggestionId: suggestion.id, decision: 'accept' })),
    })).rejects.toThrow(/stale/i);
    expect(transactionQuery.mock.calls.filter(([sql]) => sql === 'ROLLBACK')).toHaveLength(2);
    expect(transactionQuery.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO tags'))).toBe(false);
  });

  it('does not reactivate an inactive taxonomy record owned by another plan', async () => {
    const fake = proposalDatabase();
    const service = new OrganizationService(fake.database, provider());
    const preview = await service.createProposal({ tenantId, apiKeyId }, { useModel: false, limit: 50 });
    const record = fake.record()!;
    const transactionQuery = vi.fn(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [], rowCount: null };
      if (sql.includes('FROM organization_plans')) return { rows: [record], rowCount: 1 };
      if (sql.includes('FROM content_items c')) return { rows: contentRows(), rowCount: 2 };
      if (sql.includes('FROM tags') && sql.includes('ORDER BY slug')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM libraries') && sql.includes('ORDER BY slug')) return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT id,is_active,metadata FROM tags')) {
        return { rows: [{ id: tagId, is_active: false, metadata: { organizationPlanId: randomUUID() } }], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    (fake.database as Database).connect = vi.fn().mockResolvedValue({ query: transactionQuery, release: vi.fn() }) as Database['connect'];

    await expect(service.applyPlan({ tenantId, apiKeyId }, planId, {
      decisions: preview.suggestions.map((suggestion) => ({ suggestionId: suggestion.id, decision: 'accept' })),
    })).rejects.toThrow(/manual review/i);
    expect(transactionQuery.mock.calls.some(([sql]) => String(sql).includes('SET is_active=true'))).toBe(false);
    expect(transactionQuery.mock.calls.filter(([sql]) => sql === 'ROLLBACK')).toHaveLength(1);
  });

  it('rejects organization access through a library-scoped key', async () => {
    const fake = proposalDatabase();
    const service = new OrganizationService(fake.database, provider());
    await expect(service.listPlans({ tenantId, apiKeyId, libraryId: randomUUID() }))
      .rejects.toThrow(/not found/i);
    expect(fake.query).not.toHaveBeenCalled();
  });
});
