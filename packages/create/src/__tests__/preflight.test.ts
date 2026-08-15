import { describe, expect, it, vi } from 'vitest';
import { runPreflight } from '../preflight.js';
import type { CommandRunner } from '../process.js';

const successRunner: CommandRunner = vi.fn(() => Promise.resolve({ stdout: '' }));

describe('runPreflight', () => {
  it('reports every failed prerequisite with an exact remediation', async () => {
    const result = await runPreflight({
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
        fix: 'Install Node.js 22.16 or newer, then run this command again.',
      }),
      expect.objectContaining({
        code: 'DOCKER_DAEMON',
        fix: 'Start Docker Desktop (or the Docker daemon), then run this command again.',
      }),
      expect.objectContaining({
        code: 'DOCKER_COMPOSE',
        fix: 'Install Docker Compose v2 so `docker compose version` succeeds.',
      }),
      expect.objectContaining({
        code: 'PORT_IN_USE',
        port: 5050,
        fix: 'Stop the process using port 5050, then run this command again.',
      }),
    ]));
  });

  it.each([
    '20.19.0',
    '22.15.1',
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
    '22.16.0',
    'v22.16.1',
    '23.0.0',
  ])('accepts supported Node version %s', async (nodeVersion) => {
    const result = await runPreflight({
      nodeVersion,
      runCommand: successRunner,
      probePort: vi.fn(() => Promise.resolve(true)),
    });

    expect(result).toEqual({ ok: true, failures: [] });
  });

  it('allows ports already owned by this installation on an idempotent re-run', async () => {
    const result = await runPreflight({
      nodeVersion: '22.16.0',
      runCommand: successRunner,
      probePort: vi.fn(() => Promise.resolve(false)),
      ownedPorts: new Set([5050]),
    });

    expect(result).toEqual({ ok: true, failures: [] });
  });

  it('checks every selected channel port and reports all collisions', async () => {
    const requiredPorts = [5150, 5533, 6480, 3300, 5151];
    const result = await runPreflight({
      nodeVersion: '22.16.0',
      runCommand: successRunner,
      requiredPorts,
      probePort: vi.fn(() => Promise.resolve(false)),
    });

    expect(result.failures.filter((failure) => failure.code === 'PORT_IN_USE').map((failure) => failure.port))
      .toEqual([...requiredPorts].sort((left, right) => left - right));
  });
});
