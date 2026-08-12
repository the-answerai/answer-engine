import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { mergeCodexToml } from './codex-toml.js';
import { mergeJsonClientConfig } from './json-clients.js';
import { resolveClientConfigPath } from './paths.js';
import type { WiringPathOptions } from './paths.js';
import type { FileWiringInput, WiringResult } from './types.js';

export * from './codex-toml.js';
export * from './http.js';
export * from './json-clients.js';
export * from './mcp-entry.js';
export * from './paths.js';
export * from './types.js';

export interface WireClientOptions extends WiringPathOptions {
  path?: string;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export function backupFile(path: string): string | undefined {
  try {
    const backupPath = `${path}.bak`;
    copyFileSync(path, backupPath);
    chmodSync(backupPath, 0o600);
    return backupPath;
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

export function wireClient(input: FileWiringInput, options: WireClientOptions = {}): WiringResult {
  const path = options.path ?? resolveClientConfigPath(input.client, options);
  let existing: string | undefined;
  try {
    existing = readFileSync(path, 'utf8');
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }

  const merged = input.client === 'codex'
    ? mergeCodexToml(existing ?? '', input)
    : mergeJsonClientConfig(existing ?? '', input);

  if (existing === merged) {
    chmodSync(path, 0o600);
    return { path, created: false };
  }

  const backupPath = existing === undefined ? undefined : backupFile(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, merged, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);

  return {
    path,
    ...(backupPath ? { backupPath } : {}),
    created: existing === undefined,
  };
}
