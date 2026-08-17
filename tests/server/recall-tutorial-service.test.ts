import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../src/config/database.js';
import { RecallTutorialService } from '../../src/services/recall-tutorial/recall-tutorial-service.js';

const tenantId = randomUUID();
const apiKeyId = randomUUID();
const tutorialId = randomUUID();
const contentId = randomUUID();
const now = new Date('2026-08-15T20:00:00.000Z');

function tutorialRow(overrides: Record<string, unknown> = {}) {
  return {
    id: tutorialId, status: 'planned', write_client: 'codex', recall_client: 'claude-code',
    marker: 'ae-demo-111111111111', fact: 'For ae-demo-111111111111, the harmless demo lighthouse color is cobalt.',
    source_identifier: 'recall-tutorial:ae-demo-111111111111', content_id: null,
    diagnostic_code: 'waiting_for_remember', diagnostic_details: {}, remembered_at: null,
    verified_at: null, created_at: now, updated_at: now, ...overrides,
  };
}

describe('RecallTutorialService', () => {
  it('preflights unsupported combinations before creating a challenge', async () => {
    const query = vi.fn();
    const service = new RecallTutorialService({ query } as unknown as Database);
    await expect(service.create({ tenantId, apiKeyId }, {
      writeClient: 'chatgpt-web', recallClient: 'codex', environment: 'native',
    })).rejects.toThrow(/cannot connect directly to a localhost/i);
    await expect(service.create({ tenantId, apiKeyId }, {
      writeClient: 'codex', recallClient: 'claude-desktop', environment: 'wsl',
    })).rejects.toThrow(/Windows host/i);
    await expect(service.create({ tenantId, apiKeyId }, {
      writeClient: 'codex', recallClient: 'chatgpt-desktop', environment: 'native',
    })).rejects.toThrow(/share one local plugin/i);
    expect(query).not.toHaveBeenCalled();
  });

  it('creates a harmless cross-client challenge whose fresh-chat prompt contains no answer', async () => {
    const query = vi.fn(async (sql: string, parameters: unknown[]) => {
      expect(sql).toContain('INSERT INTO recall_tutorials');
      expect(parameters[0]).toBe(tenantId);
      const marker = parameters[3] as string;
      return { rows: [tutorialRow({ marker, fact: parameters[4], source_identifier: parameters[5] })], rowCount: 1 };
    });
    const service = new RecallTutorialService({ query } as unknown as Database);
    const result = await service.create({ tenantId, apiKeyId }, {
      writeClient: 'codex', recallClient: 'claude-code', environment: 'native',
    });
    expect(result.sameClient).toBe(false);
    expect(result.marker).toMatch(/^ae-demo-[a-f0-9]{12}$/);
    expect(result.fact).toContain('harmless demo lighthouse color');
    expect(result.instructions.remember.text).toContain(result.fact);
    expect(result.instructions.freshChat.answerBearingContextIncluded).toBe(false);
    expect(result.instructions.freshChat.text).toContain(result.marker);
    expect(result.instructions.freshChat.text).not.toContain('cobalt');
  });

  it('requires ordered remember, recall citation, and lineage audit evidence', async () => {
    let row = tutorialRow();
    let contentPresent = false;
    let recalled = false;
    let recallClient = 'codex';
    let inspected = false;
    const query = vi.fn(async (sql: string, parameters: unknown[]) => {
      expect(parameters[0]).toBe(tenantId);
      if (sql.includes('SELECT * FROM recall_tutorials')) return { rows: [row], rowCount: 1 };
      if (sql.includes('FROM content_items')) return { rows: contentPresent ? [{ id: contentId, created_at: now, content: row.fact }] : [], rowCount: contentPresent ? 1 : 0 };
      if (sql.includes("action='content.import'")) { expect(parameters.slice(2)).toEqual(['mcp', 'codex', contentId]); return { rows: [{ created_at: now }], rowCount: 1 }; }
      if (sql.includes("action='content.query'")) return { rows: recalled && recallClient === parameters[3] ? [{ created_at: now, result_ids: [contentId], surface: 'mcp' }] : [], rowCount: recalled ? 1 : 0 };
      if (sql.includes("action='content.lineage.read'")) return { rows: inspected ? [{ created_at: now }] : [], rowCount: inspected ? 1 : 0 };
      if (sql.includes('UPDATE recall_tutorials')) {
        const status = sql.includes("status='verified'") ? 'verified' : sql.includes("status='remembered'") ? 'remembered' : row.status;
        row = { ...row, status, content_id: status === 'planned' ? row.content_id : contentId,
          remembered_at: status === 'planned' ? row.remembered_at : now,
          verified_at: status === 'verified' ? now : null,
          diagnostic_code: status === 'verified' ? 'passed' : String(parameters[status === 'remembered' ? 4 : 2]),
          diagnostic_details: parameters[status === 'remembered' ? 5 : status === 'verified' ? 5 : 3] as Record<string, unknown> };
        return { rows: [row], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const service = new RecallTutorialService({ query } as unknown as Database);
    expect((await service.check({ tenantId, apiKeyId }, tutorialId, {})).diagnostic.code).toBe('waiting_for_remember');
    contentPresent = true;
    expect((await service.check({ tenantId, apiKeyId }, tutorialId, {})).diagnostic.code).toBe('waiting_for_fresh_chat');
    recalled = true;
    expect((await service.check({ tenantId, apiKeyId }, tutorialId, {})).diagnostic.code).toBe('waiting_for_fresh_chat');
    recallClient = 'claude-code';
    expect((await service.check({ tenantId, apiKeyId }, tutorialId, {})).diagnostic.code).toBe('source_evidence');
    inspected = true;
    const verified = await service.check({ tenantId, apiKeyId }, tutorialId, {});
    expect(verified.status).toBe('verified');
    expect(verified.contentId).toBe(contentId);
    expect(verified.diagnostic.code).toBe('passed');
  });

  it('reports access failures without treating them as completion and hides library-scoped records', async () => {
    let row = tutorialRow();
    const query = vi.fn(async (sql: string, parameters: unknown[]) => {
      if (sql.includes('SELECT *')) return { rows: [row], rowCount: 1 };
      row = { ...row, diagnostic_code: parameters[2], diagnostic_details: parameters[3] };
      return { rows: [row], rowCount: 1 };
    });
    const service = new RecallTutorialService({ query } as unknown as Database);
    const result = await service.check({ tenantId, apiKeyId }, tutorialId, { reportedFailure: 'access' });
    expect(result.status).toBe('planned');
    expect(result.diagnostic).toMatchObject({ code: 'access', details: { recovery: expect.stringMatching(/read and write/) } });
    await expect(service.get({ tenantId, apiKeyId, libraryId: randomUUID() }, tutorialId)).rejects.toThrow(/not found/i);
  });
});
