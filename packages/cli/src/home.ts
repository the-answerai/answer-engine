import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function resolveAeHome(): string {
  return resolve(process.env.AE_HOME || join(homedir(), '.answer-engine'));
}

export function configYamlPath(): string {
  return join(resolveAeHome(), 'config.yaml');
}

export function envFilePath(): string {
  return join(resolveAeHome(), '.env');
}

export function postgresDataDir(): string {
  return join(resolveAeHome(), 'data', 'postgres');
}

export function redisDataDir(): string {
  return join(resolveAeHome(), 'data', 'redis');
}

export function syncCursorFilePath(): string {
  return join(resolveAeHome(), 'data', 'sync-cursors.json');
}

export function blobsDir(): string {
  return join(resolveAeHome(), 'blobs');
}

export function rawArchiveDir(): string {
  return join(resolveAeHome(), 'raw-archive');
}

export function logsDir(): string {
  return join(resolveAeHome(), 'logs');
}

export function evalDir(): string {
  return join(resolveAeHome(), 'eval');
}

export function evalSetsDir(): string {
  return join(evalDir(), 'sets');
}

export function evalSetPath(name: string): string {
  return join(evalSetsDir(), `${name}.jsonl`);
}

export function evalResultsDir(): string {
  return join(evalDir(), 'results');
}

export function syncStdoutLogPath(): string {
  return join(logsDir(), 'sync.out.log');
}

export function syncStderrLogPath(): string {
  return join(logsDir(), 'sync.err.log');
}

export function ensureAeHomeLayout(): void {
  for (const path of [
    postgresDataDir(),
    redisDataDir(),
    blobsDir(),
    rawArchiveDir(),
    logsDir(),
    evalSetsDir(),
    evalResultsDir(),
  ]) {
    mkdirSync(path, { recursive: true });
  }
}
