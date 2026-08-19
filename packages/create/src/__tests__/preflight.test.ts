import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatPreflightReport, runPreflight } from '../preflight.js';
import type { CommandRunner } from '../process.js';

const successRunner: CommandRunner = vi.fn((_command, args) => Promise.resolve({
  stdout: args[0] === 'info' ? '27.0.0' : args[0] === 'compose' ? '2.30.0' : 'ready',
}));
const supportedHost = {
  platform: 'darwin' as const,
  architecture: 'arm64',
  totalMemoryBytes: 16 * 1024 ** 3,
  freeDiskBytes: 80 * 1024 ** 3,
  installation: 'absent' as const,
  modelRuntimeAvailable: true,
};
const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('runPreflight', () => {
  it('passes the supported Apple Silicon baseline with ordered read-only checks', async () => {
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      if (command === 'docker' && args[0] === 'info') return { stdout: 'Server Version: 27' };
      if (command === 'docker') return { stdout: '2.35.1' };
      if (command === 'lms') return { stdout: '0.3.20' };
      throw new Error(`Unexpected command: ${command}`);
    });
    const result = await runPreflight({
      platform: 'darwin', architecture: 'arm64', totalMemoryBytes: 16 * 1024 ** 3,
      freeDiskBytes: 80 * 1024 ** 3, nodeVersion: '22.23.2', runCommand,
      probePort: vi.fn(async () => true), installation: 'absent',
    });

    expect(result.status).toBe('pass');
    expect(result.system.platform).toBe('macos');
    expect(result.checks.map((check) => check.code)).toEqual([
      'OPERATING_SYSTEM', 'ARCHITECTURE', 'MEMORY', 'DISK', 'GPU', 'NODE_VERSION',
      'DOCKER_DAEMON', 'DOCKER_COMPOSE', 'WSL2', 'MODEL_RUNTIME', 'PORTS', 'INSTALLATION',
    ]);
  });

  it('passes the supported Windows 11 WSL2 baseline with an 8 GB Nvidia GPU', async () => {
    const runCommand = vi.fn(async (command: string, args: string[]) => ({
      stdout: command === 'nvidia-smi' ? '8192\n'
        : args[0] === 'info' ? '27.0.0\n' : args[0] === 'compose' ? '2.30.0\n' : 'ready\n',
    }));
    const result = await runPreflight({
      platform: 'linux', architecture: 'x64', osRelease: '5.15-microsoft-standard-WSL2',
      totalMemoryBytes: 24 * 1024 ** 3, freeDiskBytes: 100 * 1024 ** 3,
      nodeVersion: '22.23.2', runCommand, probePort: vi.fn(async () => true),
      installation: 'managed', modelRuntimeAvailable: true,
    });

    expect(result.status).toBe('pass');
    expect(result.system).toMatchObject({
      platform: 'windows-wsl2', architecture: 'x64', gpu: { kind: 'nvidia', vramGb: 8 },
    });
  });

  it('does not mistake WSL1 for the supported WSL2 baseline', async () => {
    const result = await runPreflight({
      platform: 'linux', architecture: 'x64', osRelease: '4.4.0-19041-Microsoft',
      totalMemoryBytes: 24 * 1024 ** 3, freeDiskBytes: 100 * 1024 ** 3,
      nodeVersion: '22.23.2', runCommand: successRunner,
      probePort: vi.fn(async () => true), installation: 'absent', modelRuntimeAvailable: true,
    });

    expect(result.status).toBe('unsupported');
    expect(result.system.platform).toBe('linux');
    expect(result.checks.find((item) => item.code === 'WSL2')).toMatchObject({
      status: 'unsupported',
      remediation: expect.stringContaining('WSL2'),
    });
  });

  it('returns exact actionable human and JSON output for remediable states', async () => {
    const result = await runPreflight({
      platform: 'darwin', architecture: 'arm64', totalMemoryBytes: 12 * 1024 ** 3,
      freeDiskBytes: 20 * 1024 ** 3, nodeVersion: '22.23.2', runCommand: successRunner,
      probePort: vi.fn(async () => true), installation: 'partial', modelRuntimeAvailable: false,
    });

    expect(result.status).toBe('warning');
    expect(result.checks.filter((check) => check.status !== 'pass').every((check) => Boolean(check.remediation))).toBe(true);
    expect(formatPreflightReport(result)).toContain('[WARNING] Memory (required; manual): 12 GB detected');
    expect(JSON.parse(formatPreflightReport(result, true))).toEqual(result);
  });

  it('does not mutate an existing or partial installation while probing it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ae-preflight-readonly-'));
    tempDirs.push(home);
    writeFileSync(join(home, 'config.yaml'), 'models: {}\n');
    const before = readdirSync(home);

    const result = await runPreflight({
      home, platform: 'darwin', architecture: 'arm64', totalMemoryBytes: 16 * 1024 ** 3,
      freeDiskBytes: 60 * 1024 ** 3, nodeVersion: '22.23.2', runCommand: successRunner,
      probePort: vi.fn(async () => true), modelRuntimeAvailable: true,
    });

    expect(result.installation).toBe('partial');
    expect(readdirSync(home)).toEqual(before);
  });

  it('marks unsupported native Windows with a concrete WSL2 remediation', async () => {
    const result = await runPreflight({
      platform: 'win32', architecture: 'x64', totalMemoryBytes: 32 * 1024 ** 3,
      freeDiskBytes: 100 * 1024 ** 3, nodeVersion: '22.23.2', runCommand: successRunner,
      probePort: vi.fn(async () => true), modelRuntimeAvailable: true,
    });

    expect(result.status).toBe('unsupported');
    expect(result.checks.find((item) => item.code === 'WSL2')?.remediation).toContain('enter WSL2');
  });

  it('reports every failed prerequisite with an exact remediation', async () => {
    const result = await runPreflight({
      ...supportedHost,
      nodeVersion: '18.19.0',
      runCommand: vi.fn((_command, args) => Promise.reject(new Error(
        args[0] === 'info' ? 'daemon unavailable' : 'compose unavailable',
      ))),
      probePort: vi.fn((port) => Promise.resolve(port !== 5050)),
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'NODE_VERSION',
        fix: expect.stringContaining('official user-scoped Node.js 22.23.2 archive'),
      }),
      expect.objectContaining({
        code: 'DOCKER_DAEMON',
        fix: 'Install or start Docker Desktop manually, then run this command again.',
      }),
      expect.objectContaining({
        code: 'DOCKER_COMPOSE',
        fix: 'Install Docker Desktop or Compose v2 manually so `docker compose version --short` succeeds.',
      }),
      expect.objectContaining({
        code: 'PORT_IN_USE',
        port: 5050,
        fix: 'Stop the process using port 5050, then run this command again.',
      }),
    ]));
  });

  it('classifies reusable, consented, privileged, and optional dependencies', async () => {
    const result = await runPreflight({
      ...supportedHost,
      nodeVersion: '20.19.0',
      modelRuntimeAvailable: false,
      runCommand: vi.fn(async (command: string) => {
        if (command === 'docker') throw new Error('missing');
        return { stdout: '' };
      }),
      probePort: vi.fn(async () => true),
    });

    expect(result.checks.find((item) => item.code === 'NODE_VERSION')).toMatchObject({
      requirement: 'required', dependencyState: 'incompatible', installPolicy: 'user-consent',
      detectedVersion: '20.19.0', proposal: { source: expect.stringContaining('node-v22.23.2-darwin-arm64') },
    });
    expect(result.checks.find((item) => item.code === 'DOCKER_DAEMON')).toMatchObject({
      requirement: 'required', installPolicy: 'privileged', blocking: true,
    });
    expect(result.checks.find((item) => item.code === 'MODEL_RUNTIME')).toMatchObject({
      requirement: 'optional', installPolicy: 'manual', blocking: false,
    });
  });

  it.each(['', 'available', 'v1.29.2'])('rejects non-v2 Compose version output %j', async (composeVersion) => {
    const result = await runPreflight({
      ...supportedHost,
      nodeVersion: '22.23.2',
      runCommand: vi.fn(async (_command: string, args: string[]) => ({
        stdout: args[0] === 'info' ? '27.0.0' : composeVersion,
      })),
      probePort: vi.fn(async () => true),
    });

    expect(result.ok).toBe(false);
    expect(result.checks.find((item) => item.code === 'DOCKER_COMPOSE')).toMatchObject({
      status: 'warning', blocking: true, installPolicy: 'privileged',
    });
  });

  it('does not propose the Apple Silicon Node archive for an unsupported architecture', async () => {
    const result = await runPreflight({
      ...supportedHost, architecture: 'x64', nodeVersion: '20.0.0', runCommand: successRunner,
      probePort: vi.fn(async () => true),
    });

    const node = result.checks.find((item) => item.code === 'NODE_VERSION');
    expect(node).toMatchObject({ installPolicy: 'manual' });
    expect(node).not.toHaveProperty('proposal');
  });

  it.each([
    '20.19.0',
    '22.15.1',
    '22.23.1',
    'not-a-version',
  ])('rejects unsupported Node version %s', async (nodeVersion) => {
    const result = await runPreflight({
      nodeVersion,
      runCommand: successRunner,
      probePort: vi.fn(() => Promise.resolve(true)),
    });

    expect(result.failures).toContainEqual(expect.objectContaining({
      code: 'NODE_VERSION',
    }));
  });

  it.each([
    '22.23.2',
    'v22.23.3',
    '23.0.0',
  ])('accepts supported Node version %s', async (nodeVersion) => {
    const result = await runPreflight({
      ...supportedHost,
      nodeVersion,
      runCommand: successRunner,
      probePort: vi.fn(() => Promise.resolve(true)),
    });

    expect(result).toMatchObject({ status: 'pass', ok: true, failures: [] });
  });

  it('allows ports already owned by this installation on an idempotent re-run', async () => {
    const result = await runPreflight({
      ...supportedHost,
      nodeVersion: '22.23.2',
      runCommand: successRunner,
      probePort: vi.fn(() => Promise.resolve(false)),
      ownedPorts: new Set([5050]),
    });

    expect(result).toMatchObject({ status: 'pass', ok: true, failures: [] });
  });

  it('checks every selected channel port and reports all collisions', async () => {
    const requiredPorts = [5150, 5533, 6480, 3300, 5151];
    const result = await runPreflight({
      nodeVersion: '22.23.2',
      runCommand: successRunner,
      requiredPorts,
      probePort: vi.fn(() => Promise.resolve(false)),
    });

    expect(result.failures.filter((failure) => failure.code === 'PORT_IN_USE').map((failure) => failure.port))
      .toEqual([...requiredPorts].sort((left, right) => left - right));
  });
});
