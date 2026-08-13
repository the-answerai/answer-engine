import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));

function read(relativePath: string): string {
  return readFileSync(join(root, relativePath), 'utf8');
}

function files(relativeDirectory: string): string[] {
  const directory = join(root, relativeDirectory);
  return readdirSync(directory).flatMap((entry) => {
    const relativePath = join(relativeDirectory, entry);
    return statSync(join(root, relativePath)).isDirectory() ? files(relativePath) : [relativePath];
  }).sort();
}

describe('Alpha Loop repository posture', () => {
  it('pins the safe epic runner configuration', () => {
    const config = parse(read('.alpha-loop.yaml')) as Record<string, unknown>;

    expect(config).toMatchObject({
      repo: 'the-answerai/answer-engine',
      agent: 'codex',
      base_branch: 'master',
      label: 'ready',
      auto_merge: true,
      test_command: 'pnpm verify',
      setup_command: 'pnpm browser:prepare',
      batch: true,
      batch_size: 1,
      max_issues: 6,
      max_session_duration: 21600,
      skip_tests: false,
      skip_review: false,
      skip_e2e: false,
      skip_preflight: false,
      skip_verify: false,
      skip_learn: false,
      skip_install: false,
      harnesses: ['codex', 'claude-code'],
    });
    expect(config.automation_policy).toMatchObject({
      require_labels: ['ready'],
      block_labels: ['do-not-automate', 'needs-human-input'],
      max_active_sessions: 1,
    });
  });

  it('tracks the vision, context, canonical templates, and learning storage', () => {
    for (const path of [
      '.alpha-loop/vision.md',
      '.alpha-loop/context.md',
      '.alpha-loop/templates/instructions.md',
      '.alpha-loop/templates/skills/alpha-loop-runner/SKILL.md',
      '.alpha-loop/learnings/issue-7-20260812-162800.md',
    ]) {
      expect(existsSync(join(root, path)), path).toBe(true);
    }

    expect(read('.alpha-loop/templates/skills/alpha-loop-runner/SKILL.md'))
      .toContain('Repo: `the-answerai/answer-engine`');
  });

  it('keeps both harness outputs synchronized with project templates', () => {
    const canonicalSkills = files('.alpha-loop/templates/skills')
      .map((path) => path.replace('.alpha-loop/templates/skills/', ''));

    for (const target of ['.agents/skills', '.claude/skills']) {
      expect(files(target).map((path) => path.replace(`${target}/`, ''))).toEqual(canonicalSkills);
    }

    const canonicalAgents = files('.alpha-loop/templates/agents')
      .map((path) => path.replace('.alpha-loop/templates/agents/', ''));
    for (const target of ['.codex/agents', '.claude/agents']) {
      expect(files(target).map((path) => path.replace(`${target}/`, ''))).toEqual(canonicalAgents);
    }
  });

  it('pins sandbox-safe agent-browser verification for UI workers', () => {
    const requiredInstruction = /Do not\s+substitute\s+`playwright-cli`/;
    const browserConfig = JSON.parse(read('agent-browser.json')) as {
      session?: string;
    };
    const packageManifest = JSON.parse(read('package.json')) as {
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    const browserWrapper = read('scripts/agent-browser.sh');

    expect(existsSync(join(root, '.alpha-loop/templates/skills/agent-browser/SKILL.md'))).toBe(true);
    expect(existsSync(join(root, '.alpha-loop/templates/skills/playwright-cli'))).toBe(false);
    expect(read('.alpha-loop/templates/skills/agent-browser/SKILL.md'))
      .toContain('pnpm browser:ui set viewport 375 812');
    expect(packageManifest.devDependencies?.['agent-browser']).toBe('0.34.0');
    expect(packageManifest.scripts).toMatchObject({
      'browser:ui': 'bash scripts/agent-browser.sh',
      'browser:prepare': 'pnpm browser:ui open about:blank',
    });
    expect(read('AGENTS.md')).toMatch(requiredInstruction);
    expect(read('.alpha-loop/templates/instructions.md')).toMatch(requiredInstruction);
    expect(browserConfig).toEqual({ session: 'answer-engine-oss' });
    expect(browserWrapper).toContain('AGENT_BROWSER_SOCKET_DIR');
    expect(browserWrapper).toContain('AGENT_BROWSER_PROFILE');
    expect(browserWrapper).toContain('/tmp/answer-engine-oss-browser');
    expect(browserWrapper).not.toContain('$HOME');
    expect(read('.gitignore')).toContain('.agent-browser/');
  });

  it('defines only the five paid capability families as private', () => {
    const agentGuide = read('AGENTS.md');
    const readme = read('README.md');
    const boundaryGuard = read('scripts/check-public-boundary.ts');

    for (const document of [agentGuide, readme]) {
      expect(document).toContain('roles, RBAC, teams, billing, and');
      expect(document).toContain('permissions');
    }
    expect(agentGuide).toContain('Local administration');
    expect(agentGuide).toContain('workspace');
    expect(boundaryGuard).not.toMatch(/workspaces?\?/);
    expect(boundaryGuard).not.toMatch(/admin\(\?:istration\)/);
    expect(boundaryGuard).toContain('paidCapabilityPatterns');
    expect(boundaryGuard).toContain('role[-_ ]?based');
  });

  it('keeps Graphify outside the epic in every worker instruction source', () => {
    const exclusion = 'Do not load, invoke, use, update, or generate Graphify';

    expect(read('AGENTS.md')).toContain(exclusion);
    expect(read('.alpha-loop/templates/instructions.md')).toContain(exclusion);
    expect(read('CLAUDE.md')).toContain(exclusion);
    expect(read('.alpha-loop/vision.md')).toContain('Graphify and generated graph artifacts are outside this epic');
  });

  it('keeps repository policy scans out of transient Alpha Loop worktrees', () => {
    expect(read('scripts/check-public-boundary.ts'))
      .toContain("new Set(['.git', '.worktrees', 'dist', 'node_modules'])");
  });
});
