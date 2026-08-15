import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const templateRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'integrations', 'answer-engine');

const EvalSchema = z.object({
  skill_name: z.string().min(1),
  evals: z.array(z.object({
    id: z.number().int().positive(),
    prompt: z.string().min(1),
    expected_output: z.string().min(1),
    assertions: z.array(z.string().min(1)).min(1),
    files: z.array(z.string()),
  }).strict()).min(1),
}).strict();

describe('Answer Engine plugin skills', () => {
  it('packages valid dual-host manifests, pinned MCP metadata, and focused skills', () => {
    const codex = JSON.parse(readFileSync(join(templateRoot, '.codex-plugin', 'plugin.json'), 'utf8')) as Record<string, unknown>;
    const claude = JSON.parse(readFileSync(join(templateRoot, '.claude-plugin', 'plugin.json'), 'utf8')) as Record<string, unknown>;
    const mcp = readFileSync(join(templateRoot, '.mcp.json'), 'utf8');
    expect(codex).toMatchObject({
      name: 'answer-engine', version: '1.1.0',
      mcpServers: { 'answer-engine': { command: '__ANSWER_ENGINE_MCP_COMMAND__' } },
    });
    expect(claude).toMatchObject({ name: 'answer-engine', version: '1.1.0' });
    expect(mcp).toContain('__ANSWER_ENGINE_MCP_COMMAND__');
    expect(mcp).not.toContain('@answer-engine/mcp-server');
    expect(mcp).not.toMatch(/ae_live_[A-Za-z0-9]/);
    expect(readdirSync(join(templateRoot, 'skills')).sort()).toEqual([
      'install-answer-engine', 'organize-answer-engine', 'use-answer-engine',
    ]);
  });

  it('packages schema-valid activation and workflow eval fixtures for every skill', () => {
    for (const skill of ['install-answer-engine', 'use-answer-engine', 'organize-answer-engine']) {
      const body = readFileSync(join(templateRoot, 'skills', skill, 'SKILL.md'), 'utf8');
      expect(body).toMatch(new RegExp(`^---\\nname: ${skill}\\ndescription: .+\\n---`, 's'));
      expect(body).toContain('../../references/safety.md');
      const evals = EvalSchema.parse(JSON.parse(readFileSync(join(templateRoot, 'evals', `${skill}.json`), 'utf8')));
      expect(evals.skill_name).toBe(skill);
    }
  });
});
