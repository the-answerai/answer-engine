import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type {
  AnswerEngineClient,
  FirstImportDiscoveryRequest,
  FirstImportDiscoverySource,
  FirstImportSession,
  FirstImportSourceId,
} from '../api-client.js';
import { configYamlPath, firstImportDir } from '../home.js';
import { loadUserConfig } from '../user-config.js';
import { claudeCodeSource } from './sources/claude-code.js';
import { codexSource } from './sources/codex.js';
import { coworkSource } from './sources/cowork.js';
import type { TranscriptSource } from './types.js';

const SOURCE_GUIDANCE: Record<FirstImportSourceId, {
  privacyPosture: string;
  exclusions: string[];
}> = {
  'claude-code': {
    privacyPosture: 'Discovery reads file names and statistics only. Transcript bodies are read only after approval and remain local.',
    exclusions: ['audit logs', 'prompt history', 'subagent files imported only with their parent session'],
  },
  codex: {
    privacyPosture: 'Discovery reads file names and statistics only. Rollout bodies are read only after approval and remain local.',
    exclusions: ['prompt history', 'logs', 'shell snapshots', 'worktrees', 'generated images'],
  },
  cowork: {
    privacyPosture: 'Discovery validates the local Cowork bundle shape without reading transcript bodies. Approved bundles remain local.',
    exclusions: ['application caches', 'IndexedDB', 'local storage', 'session storage'],
  },
};

function metadataFingerprint(sourceId: FirstImportSourceId, file: {
  path: string; identity?: string; size: number; mtimeMs: number;
}): string {
  return createHash('sha256').update([
    sourceId, file.path, file.identity ?? '', String(file.size), String(file.mtimeMs),
  ].join('\0')).digest('hex');
}

export async function discoverFirstImportSources(
  adapters: readonly TranscriptSource[] = [claudeCodeSource, codexSource, coworkSource],
): Promise<FirstImportDiscoverySource[]> {
  const discovered = await Promise.all(adapters.map(async (adapter) => {
    const files = await adapter.discover({ inventoryOnly: true });
    const items = files.map((file) => ({
      fingerprint: metadataFingerprint(adapter.id, file),
      sourcePath: file.path,
      byteSize: file.size,
      modifiedAt: new Date(file.mtimeMs).toISOString(),
    }));
    const paths = [...new Set(files.map((file) => dirname(file.path)))].sort();
    return {
      sourceId: adapter.id,
      label: adapter.label,
      paths,
      estimatedCount: items.length,
      estimatedBytes: items.reduce((total, item) => total + item.byteSize, 0),
      ...SOURCE_GUIDANCE[adapter.id],
      availability: files.length > 0
        ? 'available'
        : adapter.id === 'cowork' && process.platform !== 'darwin' && !process.env.CLAUDE_DESKTOP_HOME
          ? 'unsupported_platform'
          : 'not_found',
      availabilityNote: files.length > 0
        ? 'Local source history is available for selection.'
        : adapter.id === 'cowork' && process.platform !== 'darwin' && !process.env.CLAUDE_DESKTOP_HOME
          ? 'Default local Cowork discovery is available on macOS; set CLAUDE_DESKTOP_HOME for an explicit host export.'
          : 'No supported history files were found at the default source path.',
      items,
    } satisfies FirstImportDiscoverySource;
  }));
  return discovered;
}

export function firstImportManifestPath(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return join(firstImportDir(), `discovery-${timestamp}-${randomUUID()}.json`);
}

export function writeFirstImportManifest(
  path: string,
  sessionId: string,
  sources: readonly FirstImportDiscoverySource[],
): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ version: 1, sessionId, sources }, null, 2)}\n`, {
      encoding: 'utf8', mode: 0o600, flag: 'wx',
    });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* temporary file may not exist */ }
    throw error;
  }
}

export function mergeApprovedHistorySources(
  path: string = configYamlPath(),
  sourceIds: readonly FirstImportSourceId[],
): void {
  const config = loadUserConfig(path);
  const existing = new Set(config.sources.map((source) => source.type));
  const additions = sourceIds.filter((sourceId) => !existing.has(sourceId)).map((type) => ({ type }));
  if (additions.length === 0) return;
  const merged = { ...config, sources: [...config.sources, ...additions] };
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temporary, stringifyYaml(merged), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* temporary file may not exist */ }
    throw error;
  }
}

export async function registerFirstImportDiscovery(
  client: Pick<AnswerEngineClient, 'registerFirstImport'>,
): Promise<FirstImportSession> {
  const sources = await discoverFirstImportSources();
  if (!sources.some((source) => source.availability === 'available')) {
    throw new Error('No supported Claude Code, Codex, or Cowork history was discovered.');
  }
  const manifestPath = firstImportManifestPath();
  const request: FirstImportDiscoveryRequest = { manifestPath, sources };
  const session = (await client.registerFirstImport(request)).data;
  writeFirstImportManifest(manifestPath, session.id, sources);
  return session;
}

export function readFirstImportManifest(path: string): FirstImportDiscoveryRequest & { sessionId: string } {
  return JSON.parse(readFileSync(path, 'utf8')) as FirstImportDiscoveryRequest & { sessionId: string };
}
