import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const templateRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'integrations', 'answer-engine');
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const skillNames = ['install-answer-engine', 'use-answer-engine', 'organize-answer-engine'] as const;

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

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const GradeEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  evaluatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sources: z.object({
    runsSha256: Sha256Schema,
    skills: z.record(Sha256Schema),
    evals: z.record(Sha256Schema),
    fixtures: z.record(Sha256Schema),
  }).strict(),
  activation: z.object({
    passed: z.boolean(),
    evidence: z.string().min(1),
    decisions: z.array(z.object({
      promptId: z.number().int().positive(),
      selected: z.string().min(1),
      passed: z.boolean(),
    }).strict()),
  }).strict(),
  runs: z.array(z.object({
    skill_name: z.string().min(1),
    configuration: z.enum(['with_skill', 'baseline']),
    expectations: z.array(z.object({
      text: z.string().min(1),
      passed: z.boolean(),
      evidence: z.string().min(1),
    }).strict()).min(1),
    pass_rate: z.number().min(0).max(1),
  }).strict()),
  analysis: z.object({
    withSkillPassRate: z.number().min(0).max(1),
    baselinePassRate: z.number().min(0).max(1),
    observations: z.array(z.string().min(1)).min(1),
  }).strict(),
}).strict();

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('Answer Engine plugin skills', () => {
  it('packages valid dual-host manifests, pinned MCP metadata, and focused skills', () => {
    const codex = JSON.parse(readFileSync(join(templateRoot, '.codex-plugin', 'plugin.json'), 'utf8')) as Record<string, unknown>;
    const claude = JSON.parse(readFileSync(join(templateRoot, '.claude-plugin', 'plugin.json'), 'utf8')) as Record<string, unknown>;
    const mcp = readFileSync(join(templateRoot, '.mcp.json'), 'utf8');
    expect(codex).toMatchObject({
      name: 'answer-engine', version: '1.1.2',
      mcpServers: { 'answer-engine': { command: '__ANSWER_ENGINE_MCP_COMMAND__' } },
    });
    expect(claude).toMatchObject({ name: 'answer-engine', version: '1.1.2' });
    expect(mcp).toContain('__ANSWER_ENGINE_MCP_COMMAND__');
    expect(mcp).not.toContain('@answer-engine/mcp-server');
    expect(mcp).not.toMatch(/ae_live_[A-Za-z0-9]/);
    expect(readdirSync(join(templateRoot, 'skills')).sort()).toEqual([
      'install-answer-engine', 'organize-answer-engine', 'use-answer-engine',
    ]);
  });

  it('packages schema-valid activation and workflow eval fixtures for every skill', () => {
    for (const skill of skillNames) {
      const body = readFileSync(join(templateRoot, 'skills', skill, 'SKILL.md'), 'utf8');
      expect(body).toMatch(new RegExp(`^---\\nname: ${skill}\\ndescription: .+\\n---`, 's'));
      expect(body).toContain('../../references/safety.md');
      const evals = EvalSchema.parse(JSON.parse(readFileSync(join(templateRoot, 'evals', `${skill}.json`), 'utf8')));
      expect(evals.skill_name).toBe(skill);
      for (const evalCase of evals.evals) {
        for (const relative of evalCase.files) {
          expect(normalize(relative)).not.toMatch(/^\.\.(?:[\\/]|$)/);
          expect(() => readFileSync(join(templateRoot, 'evals', relative), 'utf8')).not.toThrow();
        }
      }
    }
  });

  it('requires current independently graded activation and workflow evidence', () => {
    const evidenceRoot = join(repositoryRoot, 'docs', 'acceptance', 'evidence');
    const runsPath = join(evidenceRoot, 'issue-43-skill-eval-runs.md');
    const evidence = GradeEvidenceSchema.parse(JSON.parse(readFileSync(
      join(evidenceRoot, 'issue-43-skill-eval-grades.json'),
      'utf8',
    )));

    expect(evidence.sources.runsSha256).toBe(sha256(runsPath));
    expect(evidence.activation.passed).toBe(true);
    expect(evidence.activation.decisions).toEqual([
      { promptId: 1, selected: 'install-answer-engine', passed: true },
      { promptId: 2, selected: 'use-answer-engine', passed: true },
      { promptId: 3, selected: 'organize-answer-engine', passed: true },
      { promptId: 4, selected: 'none', passed: true },
      { promptId: 5, selected: 'none', passed: true },
      { promptId: 6, selected: 'none', passed: true },
    ]);

    const expectedFixtures: Record<string, string> = {};
    for (const skill of skillNames) {
      const skillPath = join(templateRoot, 'skills', skill, 'SKILL.md');
      const evalPath = join(templateRoot, 'evals', `${skill}.json`);
      const evals = EvalSchema.parse(JSON.parse(readFileSync(evalPath, 'utf8')));
      expect(evidence.sources.skills[skill]).toBe(sha256(skillPath));
      expect(evidence.sources.evals[skill]).toBe(sha256(evalPath));

      const assertions = evals.evals.flatMap((evalCase) => evalCase.assertions);
      for (const relative of evals.evals.flatMap((evalCase) => evalCase.files)) {
        const fixturePath = join(templateRoot, 'evals', relative);
        expectedFixtures[relative.split('/').at(-1) ?? relative] = sha256(fixturePath);
      }
      const matchingRuns = evidence.runs.filter((run) => run.skill_name === skill);
      expect(matchingRuns.map((run) => run.configuration).sort()).toEqual(['baseline', 'with_skill']);
      for (const run of matchingRuns) {
        expect(run.expectations.map((expectation) => expectation.text)).toEqual(assertions);
        const passed = run.expectations.filter((expectation) => expectation.passed).length;
        expect(run.pass_rate).toBe(passed / run.expectations.length);
      }
      expect(matchingRuns.find((run) => run.configuration === 'with_skill')?.pass_rate).toBe(1);
    }

    expect(evidence.sources.fixtures).toEqual(expectedFixtures);
    expect(evidence.analysis.withSkillPassRate).toBe(1);
    expect(evidence.analysis.baselinePassRate).toBeLessThan(1);
  });
});
