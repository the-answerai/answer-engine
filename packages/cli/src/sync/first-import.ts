import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import type {
  AnswerEngineClient,
  FirstImportDiscoveryRequest,
  FirstImportDiscoverySource,
  FirstImportSession,
  FirstImportSessionItem,
  FirstImportSourceId,
} from '../api-client.js';
import { configYamlPath, firstImportDir } from '../home.js';
import { loadUserConfig } from '../user-config.js';
import { claudeCodeSource } from './sources/claude-code.js';
import { codexSource } from './sources/codex.js';
import { coworkSource } from './sources/cowork.js';
import type { TranscriptFile, TranscriptSource } from './types.js';

const SOURCE_GUIDANCE: Record<FirstImportSourceId, {
  privacyPosture: string;
  exclusions: string[];
}> = {
  'claude-code': {
    privacyPosture: 'Discovery reads file names and statistics only. Transcript bodies are read only after approval and remain local.',
    exclusions: ['audit logs', 'prompt history', 'Claude Desktop launch metadata', 'subagent files imported only with their parent session'],
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

function metadataFingerprint(sourceId: FirstImportSourceId, file: TranscriptFile): string {
  const sourceFiles = file.inventoryFiles?.length
    ? file.inventoryFiles
    : [file];
  const hash = createHash('sha256');
  hash.update(sourceId);
  for (const inventoryFile of [...sourceFiles].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update('\0');
    hash.update([
      inventoryFile.path,
      inventoryFile.identity ?? '',
      String(inventoryFile.size),
      String(inventoryFile.mtimeMs),
    ].join('\0'));
  }
  return hash.digest('hex');
}

const DEFAULT_ADAPTERS: readonly TranscriptSource[] = [claudeCodeSource, codexSource, coworkSource];

const FirstImportManifestSchema = z.object({
  version: z.literal(1),
  sessionId: z.string().uuid(),
  sources: z.array(z.object({
    sourceId: z.enum(['claude-code', 'codex', 'cowork']),
    label: z.string(),
    paths: z.array(z.string()),
    estimatedCount: z.number().int().nonnegative(),
    estimatedBytes: z.number().int().nonnegative(),
    privacyPosture: z.string(),
    exclusions: z.array(z.string()),
    availability: z.enum(['available', 'not_found', 'unsupported_platform', 'unavailable']),
    availabilityNote: z.string(),
    items: z.array(z.object({
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      sourcePath: z.string(),
      byteSize: z.number().int().nonnegative(),
      modifiedAt: z.string().datetime(),
    }).strict()),
  }).strict()),
}).strict();

type FirstImportManifest = z.infer<typeof FirstImportManifestSchema>;

function inventoryFiles(file: TranscriptFile) {
  return file.inventoryFiles?.length ? file.inventoryFiles : [file];
}

export async function discoverFirstImportSources(
  adapters: readonly TranscriptSource[] = DEFAULT_ADAPTERS,
): Promise<FirstImportDiscoverySource[]> {
  const discovered = await Promise.all(adapters.map(async (adapter) => {
    let files;
    try {
      files = await adapter.discover({ inventoryOnly: true });
    } catch {
      return {
        sourceId: adapter.id,
        label: adapter.label,
        paths: [],
        estimatedCount: 0,
        estimatedBytes: 0,
        ...SOURCE_GUIDANCE[adapter.id],
        availability: 'unavailable',
        availabilityNote: `${adapter.label} history could not be inventoried. Check local file permissions and run discovery again.`,
        items: [],
      } satisfies FirstImportDiscoverySource;
    }
    const items = files.map((file) => ({
      fingerprint: metadataFingerprint(adapter.id, file),
      sourcePath: file.path,
      byteSize: inventoryFiles(file).reduce((total, entry) => total + entry.size, 0),
      modifiedAt: new Date(Math.max(...inventoryFiles(file).map((entry) => entry.mtimeMs))).toISOString(),
    }));
    const paths = [...new Set(files.flatMap((file) => (
      inventoryFiles(file).map((entry) => dirname(entry.path))
    )))].sort();
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

export async function firstImportItemMatchesDiscovery(
  item: Pick<FirstImportSessionItem, 'sourceId' | 'sourcePath' | 'fingerprint'>,
  adapters: readonly TranscriptSource[] = DEFAULT_ADAPTERS,
): Promise<boolean> {
  const adapter = adapters.find((candidate) => candidate.id === item.sourceId);
  if (!adapter) return false;
  const files = await adapter.discover({ paths: [item.sourcePath], inventoryOnly: true });
  const file = files.find((candidate) => candidate.path === item.sourcePath);
  return file !== undefined && metadataFingerprint(adapter.id, file) === item.fingerprint;
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

function safeFirstImportManifestPath(path: string): string {
  const configuredRoot = resolve(firstImportDir());
  const requested = resolve(path);
  const lexicalRelative = relative(configuredRoot, requested);
  if (lexicalRelative.startsWith('..') || isAbsolute(lexicalRelative)) {
    throw new Error('First-import manifest is outside the selected runtime home');
  }
  const root = realpathSync(configuredRoot);
  const canonical = realpathSync(requested);
  const canonicalRelative = relative(root, canonical);
  if (canonicalRelative.startsWith('..') || isAbsolute(canonicalRelative)) {
    throw new Error('First-import manifest resolves outside the selected runtime home');
  }
  return canonical;
}

export function readFirstImportManifest(path: string): FirstImportManifest {
  try {
    return FirstImportManifestSchema.parse(
      JSON.parse(readFileSync(safeFirstImportManifestPath(path), 'utf8')),
    );
  } catch (error) {
    throw new Error('The local first-import discovery manifest is missing, unsafe, or invalid', {
      cause: error,
    });
  }
}

function comparableSources(session: FirstImportSession): FirstImportDiscoverySource[] {
  return session.sources.map((source) => ({
    sourceId: source.sourceId,
    label: source.label,
    paths: source.paths,
    estimatedCount: source.estimatedCount,
    estimatedBytes: source.estimatedBytes,
    privacyPosture: source.privacyPosture,
    exclusions: source.exclusions,
    availability: source.availability,
    availabilityNote: source.availabilityNote,
    items: session.items
      .filter((item) => item.sourceId === source.sourceId)
      .map((item) => ({
        fingerprint: item.fingerprint,
        sourcePath: item.sourcePath,
        byteSize: item.byteSize,
        modifiedAt: item.modifiedAt,
      })),
  }));
}

function canonicalSources(sources: readonly FirstImportDiscoverySource[]): FirstImportDiscoverySource[] {
  return sources
    .map((source) => ({
      ...source,
      paths: [...source.paths].sort(),
      items: [...source.items].sort((left, right) => (
        left.sourcePath.localeCompare(right.sourcePath)
        || left.fingerprint.localeCompare(right.fingerprint)
      )),
    }))
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId));
}

export function assertFirstImportManifestMatchesSession(session: FirstImportSession): void {
  const manifest = readFirstImportManifest(session.manifestPath);
  if (
    manifest.sessionId !== session.id
    || JSON.stringify(canonicalSources(manifest.sources))
      !== JSON.stringify(canonicalSources(comparableSources(session)))
  ) {
    throw new Error('The local first-import discovery manifest does not match the server inventory');
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
  const manifestPath = firstImportManifestPath();
  const request: FirstImportDiscoveryRequest = { manifestPath, sources };
  const session = (await client.registerFirstImport(request)).data;
  writeFirstImportManifest(manifestPath, session.id, sources);
  return session;
}
