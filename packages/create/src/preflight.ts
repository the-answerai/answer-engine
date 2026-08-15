import { createServer } from 'node:net';
import type { CommandRunner } from './process.js';
import { runCommand as defaultRunCommand } from './process.js';

export const REQUIRED_PORTS = [5050] as const;

export type PreflightFailureCode =
  | 'NODE_VERSION'
  | 'DOCKER_DAEMON'
  | 'DOCKER_COMPOSE'
  | 'PORT_IN_USE';

export interface PreflightFailure {
  code: PreflightFailureCode;
  message: string;
  fix: string;
  port?: number;
}

export interface PreflightResult {
  ok: boolean;
  failures: PreflightFailure[];
}

export interface PreflightDependencies {
  nodeVersion?: string;
  runCommand?: CommandRunner;
  probePort?: (port: number) => Promise<boolean>;
  ownedPorts?: ReadonlySet<number>;
  requiredPorts?: readonly number[];
}

export async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

const MINIMUM_NODE_VERSION = [22, 16, 0] as const;

function supportsNode(version: string): boolean {
  const match = version.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;

  const actual = match.slice(1).map(Number);
  for (let index = 0; index < MINIMUM_NODE_VERSION.length; index += 1) {
    const difference = (actual[index] ?? 0) - MINIMUM_NODE_VERSION[index];
    if (difference !== 0) return difference > 0;
  }
  return true;
}

export async function runPreflight(
  dependencies: PreflightDependencies = {},
): Promise<PreflightResult> {
  const failures: PreflightFailure[] = [];
  const version = dependencies.nodeVersion ?? process.versions.node;
  const command = dependencies.runCommand ?? defaultRunCommand;
  const probePort = dependencies.probePort ?? isPortFree;
  const ownedPorts = dependencies.ownedPorts ?? new Set<number>();
  const requiredPorts = dependencies.requiredPorts ?? REQUIRED_PORTS;

  if (!supportsNode(version)) {
    failures.push({
      code: 'NODE_VERSION',
      message: `Node.js ${version} is unsupported; Answer Engine requires Node.js 22.16 or newer.`,
      fix: 'Install Node.js 22.16 or newer, then run this command again.',
    });
  }

  await Promise.all([
    command('docker', ['info']).catch(() => {
      failures.push({
        code: 'DOCKER_DAEMON',
        message: 'The Docker daemon is not running or is not reachable.',
        fix: 'Start Docker Desktop (or the Docker daemon), then run this command again.',
      });
    }),
    command('docker', ['compose', 'version']).catch(() => {
      failures.push({
        code: 'DOCKER_COMPOSE',
        message: 'Docker Compose v2 is not available.',
        fix: 'Install Docker Compose v2 so `docker compose version` succeeds.',
      });
    }),
  ]);

  await Promise.all(requiredPorts.map(async (port) => {
    if (ownedPorts.has(port) || await probePort(port)) return;
    failures.push({
      code: 'PORT_IN_USE',
      port,
      message: `Required port ${port} is already in use.`,
      fix: `Stop the process using port ${port}, then run this command again.`,
    });
  }));

  failures.sort((left, right) => {
    const order: PreflightFailureCode[] = [
      'NODE_VERSION',
      'DOCKER_DAEMON',
      'DOCKER_COMPOSE',
      'PORT_IN_USE',
    ];
    return order.indexOf(left.code) - order.indexOf(right.code)
      || (left.port ?? 0) - (right.port ?? 0);
  });
  return { ok: failures.length === 0, failures };
}

export function formatPreflightFailures(failures: PreflightFailure[]): string {
  return failures
    .map((failure) => `${failure.message}\n  Fix: ${failure.fix}`)
    .join('\n');
}
