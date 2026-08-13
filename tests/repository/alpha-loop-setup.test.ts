import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
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
      'browser:prepare': 'CI=true pnpm install --frozen-lockfile && pnpm browser:ui prepare',
    });
    expect(read('AGENTS.md')).toMatch(requiredInstruction);
    expect(read('.alpha-loop/templates/instructions.md')).toMatch(requiredInstruction);
    expect(browserConfig).toEqual({ session: 'answer-engine-oss' });
    expect(browserWrapper).toContain('AGENT_BROWSER_SOCKET_DIR');
    expect(browserWrapper).toContain('AGENT_BROWSER_PROFILE');
    expect(browserWrapper).toContain('AGENT_BROWSER_SCREENSHOT_DIR="$PWD"');
    expect(browserWrapper).toContain('/tmp/answer-engine-oss-browser');
    expect(browserWrapper).toContain('stop_project_daemon');
    expect(browserWrapper).not.toContain('$HOME');
    expect(read('.gitignore')).toContain('.agent-browser/');
  });

  it('replaces a daemon rooted in a prior worktree before browser preflight', async () => {
    const fixtureRoot = mkdtempSync(join(root, '.agent-browser-daemon-test-'));
    const runtimeDirectory = mkdtempSync(join(tmpdir(), 'answer-engine-browser-test-'));
    const fakeBinDirectory = join(fixtureRoot, 'fake-bin');
    const fakeDaemonDirectory = join(
      fixtureRoot,
      'old-worktree/node_modules/agent-browser/bin',
    );
    const fakeDaemon = join(fakeDaemonDirectory, 'agent-browser-test');
    const invocationFile = join(runtimeDirectory, 'pnpm-invocation');
    let daemon: ReturnType<typeof spawn> | undefined;

    try {
      mkdirSync(fakeBinDirectory, { recursive: true });
      mkdirSync(fakeDaemonDirectory, { recursive: true });
      mkdirSync(join(runtimeDirectory, 'socket'), { recursive: true });
      copyFileSync('/bin/sleep', fakeDaemon);
      chmodSync(fakeDaemon, 0o755);
      writeFileSync(
        join(fakeBinDirectory, 'pnpm'),
        `#!/usr/bin/env bash\nprintf '%s\\n' "$*" > "${invocationFile}"\n`,
      );
      chmodSync(join(fakeBinDirectory, 'pnpm'), 0o755);

      daemon = spawn(fakeDaemon, ['120'], { stdio: 'ignore' });
      if (daemon.pid === undefined) {
        throw new Error('Fake agent-browser daemon did not start');
      }
      writeFileSync(
        join(runtimeDirectory, 'socket/answer-engine-oss.pid'),
        String(daemon.pid),
      );

      const result = spawnSync('bash', ['scripts/agent-browser.sh', 'prepare'], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          AE_AGENT_BROWSER_RUNTIME_DIR: runtimeDirectory,
          PATH: `${fakeBinDirectory}:${process.env.PATH ?? ''}`,
        },
      });

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(invocationFile, 'utf8').trim())
        .toBe('exec agent-browser open about:blank');
      await once(daemon, 'exit');
      expect(daemon.signalCode).not.toBeNull();
    } finally {
      if (daemon?.pid !== undefined) {
        try {
          process.kill(daemon.pid, 'SIGTERM');
        } catch {
          // The preparation command is expected to stop it.
        }
      }
      rmSync(fixtureRoot, { recursive: true, force: true });
      rmSync(runtimeDirectory, { recursive: true, force: true });
    }
  });

  it('recognizes its daemon when the OSS checkout is a submodule', async () => {
    const fixtureRoot = mkdtempSync(join(root, '.agent-browser-submodule-test-'));
    const sourceRepository = join(fixtureRoot, 'source');
    const consumerRepository = join(fixtureRoot, 'consumer');
    const runtimeDirectory = join(fixtureRoot, 'runtime');
    const fakeBinDirectory = join(fixtureRoot, 'fake-bin');
    const invocationFile = join(runtimeDirectory, 'pnpm-invocation');
    let daemon: ReturnType<typeof spawn> | undefined;

    const git = (cwd: string, args: readonly string[]) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
    };

    try {
      mkdirSync(join(sourceRepository, 'scripts'), { recursive: true });
      copyFileSync(join(root, 'scripts/agent-browser.sh'), join(sourceRepository, 'scripts/agent-browser.sh'));
      chmodSync(join(sourceRepository, 'scripts/agent-browser.sh'), 0o755);
      git(sourceRepository, ['init', '--initial-branch=master']);
      git(sourceRepository, ['config', 'user.name', 'Answer Engine Test']);
      git(sourceRepository, ['config', 'user.email', 'test@example.invalid']);
      git(sourceRepository, ['add', 'scripts/agent-browser.sh']);
      git(sourceRepository, ['commit', '-m', 'test fixture']);

      mkdirSync(consumerRepository, { recursive: true });
      git(consumerRepository, ['init', '--initial-branch=master']);
      git(consumerRepository, ['config', 'user.name', 'Answer Engine Test']);
      git(consumerRepository, ['config', 'user.email', 'test@example.invalid']);
      git(consumerRepository, ['commit', '--allow-empty', '-m', 'consumer fixture']);
      git(consumerRepository, [
        '-c', 'protocol.file.allow=always', 'submodule', 'add', sourceRepository, 'vendor/answer-engine',
      ]);

      const checkout = join(consumerRepository, 'vendor/answer-engine');
      const fakeDaemonDirectory = join(
        checkout,
        'old-worktree/node_modules/agent-browser/bin',
      );
      const fakeDaemon = join(fakeDaemonDirectory, 'agent-browser-test');
      mkdirSync(fakeDaemonDirectory, { recursive: true });
      mkdirSync(join(runtimeDirectory, 'socket'), { recursive: true });
      mkdirSync(fakeBinDirectory, { recursive: true });
      copyFileSync('/bin/sleep', fakeDaemon);
      chmodSync(fakeDaemon, 0o755);
      writeFileSync(
        join(fakeBinDirectory, 'pnpm'),
        `#!/usr/bin/env bash\nprintf '%s\\n' "$*" > "${invocationFile}"\n`,
      );
      chmodSync(join(fakeBinDirectory, 'pnpm'), 0o755);

      daemon = spawn(fakeDaemon, ['120'], { stdio: 'ignore' });
      if (daemon.pid === undefined) throw new Error('Fake submodule daemon did not start');
      writeFileSync(join(runtimeDirectory, 'socket/answer-engine-oss.pid'), String(daemon.pid));

      const result = spawnSync('bash', ['scripts/agent-browser.sh', 'prepare'], {
        cwd: checkout,
        encoding: 'utf8',
        env: {
          ...process.env,
          AE_AGENT_BROWSER_RUNTIME_DIR: runtimeDirectory,
          PATH: `${fakeBinDirectory}:${process.env.PATH ?? ''}`,
        },
      });

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(invocationFile, 'utf8').trim())
        .toBe('exec agent-browser open about:blank');
      await once(daemon, 'exit');
      expect(daemon.signalCode).not.toBeNull();
    } finally {
      if (daemon?.pid !== undefined) {
        try {
          process.kill(daemon.pid, 'SIGTERM');
        } catch {
          // The preparation command is expected to stop it.
        }
      }
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('recovers a normal browser open once after a stale project daemon fails', async () => {
    const fixtureRoot = mkdtempSync(join(root, '.agent-browser-open-recovery-test-'));
    const runtimeDirectory = mkdtempSync(join(tmpdir(), 'answer-engine-browser-open-test-'));
    const fakeBinDirectory = join(fixtureRoot, 'fake-bin');
    const fakeDaemonDirectory = join(fixtureRoot, 'old-worktree/node_modules/agent-browser/bin');
    const fakeDaemon = join(fakeDaemonDirectory, 'agent-browser-test');
    const invocationFile = join(runtimeDirectory, 'pnpm-invocations');
    const attemptFile = join(runtimeDirectory, 'attempt');
    let daemon: ReturnType<typeof spawn> | undefined;

    try {
      mkdirSync(fakeBinDirectory, { recursive: true });
      mkdirSync(fakeDaemonDirectory, { recursive: true });
      mkdirSync(join(runtimeDirectory, 'socket'), { recursive: true });
      copyFileSync('/bin/sleep', fakeDaemon);
      chmodSync(fakeDaemon, 0o755);
      writeFileSync(
        join(fakeBinDirectory, 'pnpm'),
        `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${invocationFile}"\nif [[ ! -f "${attemptFile}" ]]; then\n  touch "${attemptFile}"\n  exit 1\nfi\n`,
      );
      chmodSync(join(fakeBinDirectory, 'pnpm'), 0o755);

      daemon = spawn(fakeDaemon, ['120'], { stdio: 'ignore' });
      if (daemon.pid === undefined) throw new Error('Fake stale daemon did not start');
      writeFileSync(join(runtimeDirectory, 'socket/answer-engine-oss.pid'), String(daemon.pid));

      const result = spawnSync('bash', ['scripts/agent-browser.sh', 'open', 'http://127.0.0.1:3200/content'], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          AE_AGENT_BROWSER_RUNTIME_DIR: runtimeDirectory,
          PATH: `${fakeBinDirectory}:${process.env.PATH ?? ''}`,
        },
      });

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(invocationFile, 'utf8').trim().split('\n')).toEqual([
        'exec agent-browser open http://127.0.0.1:3200/content',
        'exec agent-browser open http://127.0.0.1:3200/content',
      ]);
      await once(daemon, 'exit');
      expect(daemon.exitCode !== null || daemon.signalCode !== null).toBe(true);
    } finally {
      if (daemon?.pid !== undefined) {
        try {
          process.kill(daemon.pid, 'SIGTERM');
        } catch {
          // The recovery path is expected to stop it.
        }
      }
      rmSync(fixtureRoot, { recursive: true, force: true });
      rmSync(runtimeDirectory, { recursive: true, force: true });
    }
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
