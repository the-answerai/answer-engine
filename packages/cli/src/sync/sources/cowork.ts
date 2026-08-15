import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { attachRawArchiveManifest } from '../raw-archive.js';
import type {
  ConversationReadResult,
  TranscriptDiscoverOptions,
  TranscriptFile,
  TranscriptReadError,
  TranscriptSource,
} from '../types.js';
import {
  isMainTranscriptPath,
  parseJsonlFile,
  readClaudeCodeSessionBundle,
  resolveInputPath,
  sourceBundleFingerprint,
  sourceBundlePaths,
} from './claude-code.js';
import {
  COWORK_ADAPTER_NAME,
  COWORK_ADAPTER_VERSION,
  normalizeCoworkSession,
  type CoworkArtifactReference,
} from './cowork-normalize.js';

const SOURCE_ID = 'cowork' as const;
const SOURCE_NAME = 'Claude Cowork';
const SUPPORTED_COWORK_ARTIFACT_EXTENSIONS = new Set([
  '.csv', '.json', '.jsonl', '.md', '.markdown', '.txt',
]);
const MAX_COWORK_ARTIFACT_BYTES = 25 * 1024 * 1024;

interface CoworkBundlePaths {
  auditPath: string;
  outerPath: string;
  artifactPaths: string[];
  extraPaths: string[];
}

function expandHome(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return join(homedir(), input.slice(2));
  return input;
}

function claudeDesktopHome(): string {
  return resolve(expandHome(
    process.env.CLAUDE_DESKTOP_HOME
      ?? '~/Library/Application Support/Claude',
  ));
}

function defaultCoworkRoot(): string {
  return join(claudeDesktopHome(), 'local-agent-mode-sessions');
}

function isNestedCoworkTranscriptPath(filePath: string): boolean {
  if (!isMainTranscriptPath(filePath)) return false;
  const segments = filePath.split(sep);
  const claudeIndex = segments.lastIndexOf('.claude');
  return segments.includes('local-agent-mode-sessions')
    && claudeIndex >= 0
    && segments[claudeIndex + 1] === 'projects';
}

async function transcriptFileFromPath(filePath: string): Promise<TranscriptFile | null> {
  const stats = await stat(filePath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (!stats?.isFile()) return null;
  return {
    path: filePath,
    sourceId: SOURCE_ID,
    identity: `${stats.dev}:${stats.ino}`,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  };
}

async function isFile(path: string): Promise<boolean> {
  const stats = await stat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  return stats?.isFile() ?? false;
}

async function findAuditAncestor(transcriptPath: string): Promise<string | undefined> {
  let current = dirname(transcriptPath);
  while (true) {
    const candidate = join(current, 'audit.jsonl');
    if (await isFile(candidate)) return candidate;
    if (basename(current) === 'local-agent-mode-sessions') return undefined;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function findOuterMetadata(auditDirectory: string): Promise<string | undefined> {
  for (const directory of [auditDirectory, dirname(auditDirectory)]) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const outer = entries
      .filter((entry) => entry.isFile() && /^local_.+\.json$/i.test(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name))[0];
    if (outer) return join(directory, outer.name);
  }
  return undefined;
}

function inside(root: string, candidate: string): boolean {
  const child = relative(resolve(root), resolve(candidate));
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child));
}

async function mountedArtifactFiles(auditPath: string, outerPath: string): Promise<string[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(outerPath, 'utf8')) as unknown;
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.mountedFiles)) return [];

  const sessionRoot = dirname(outerPath);
  const runtimeRoot = dirname(auditPath);
  const paths = new Set<string>();
  for (const entry of parsed.mountedFiles) {
    if (typeof entry !== 'string' || !entry.trim()) continue;
    const segments = entry.replace(/\\/g, '/').split('/');
    if (isAbsolute(entry) || segments.includes('..')) continue;
    const artifactPath = resolve(runtimeRoot, entry);
    if (!inside(sessionRoot, artifactPath)
      || !SUPPORTED_COWORK_ARTIFACT_EXTENSIONS.has(extname(artifactPath).toLowerCase())) continue;
    const artifactStat = await lstat(artifactPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (!artifactStat?.isFile() || artifactStat.isSymbolicLink()
      || artifactStat.size > MAX_COWORK_ARTIFACT_BYTES) continue;
    paths.add(artifactPath);
  }
  return [...paths].sort();
}

async function resolveCoworkBundlePaths(transcriptPath: string): Promise<CoworkBundlePaths> {
  const auditPath = await findAuditAncestor(transcriptPath);
  if (!auditPath) throw new Error(`Cowork transcript has no audit.jsonl ancestor: ${transcriptPath}`);
  const outerPath = await findOuterMetadata(dirname(auditPath));
  if (!outerPath) throw new Error(`Cowork transcript has no outer local_*.json metadata: ${transcriptPath}`);

  const transcriptPaths = await sourceBundlePaths(transcriptPath);
  const excludedPaths = new Set([...transcriptPaths, auditPath, outerPath]);
  const artifactPaths = (await mountedArtifactFiles(auditPath, outerPath))
    .filter((path) => !excludedPaths.has(path));
  return {
    auditPath,
    outerPath,
    artifactPaths,
    extraPaths: [auditPath, outerPath, ...artifactPaths].sort(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readOuterMetadata(
  archivePath: string,
  sourcePath: string,
): Promise<{ metadata: Record<string, unknown>; errors: TranscriptReadError[] }> {
  try {
    const parsed = JSON.parse(await readFile(archivePath, 'utf8')) as unknown;
    if (!isRecord(parsed)) {
      return {
        metadata: {},
        errors: [{ filePath: sourcePath, line: 1, message: 'Cowork metadata is not an object' }],
      };
    }
    return { metadata: parsed, errors: [] };
  } catch (error) {
    return {
      metadata: {},
      errors: [{
        filePath: sourcePath,
        line: 1,
        message: error instanceof Error ? error.message : String(error),
      }],
    };
  }
}

export const coworkSource: TranscriptSource = {
  id: SOURCE_ID,
  label: SOURCE_NAME,

  async discover(options: TranscriptDiscoverOptions = {}): Promise<TranscriptFile[]> {
    const inputs = options.paths?.length ? options.paths : [defaultCoworkRoot()];
    const paths = new Set<string>();
    for (const input of inputs) {
      for (const filePath of await resolveInputPath(input)) {
        if (isNestedCoworkTranscriptPath(filePath)) paths.add(filePath);
      }
    }

    const candidates = await Promise.all([...paths].sort().map(async (path) => {
      try {
        await resolveCoworkBundlePaths(path);
        return transcriptFileFromPath(path);
      } catch {
        return null;
      }
    }));
    return candidates.filter((file): file is TranscriptFile => file !== null);
  },

  async fingerprint(file: TranscriptFile): Promise<string> {
    const paths = await resolveCoworkBundlePaths(file.path);
    return sourceBundleFingerprint(file.path, paths.extraPaths);
  },

  async readConversations(file: TranscriptFile): Promise<ConversationReadResult> {
    const paths = await resolveCoworkBundlePaths(file.path);
    const bundle = await readClaudeCodeSessionBundle(file.path, {
      adapterName: COWORK_ADAPTER_NAME,
      adapterVersion: COWORK_ADAPTER_VERSION,
      extraPaths: paths.extraPaths,
    });
    const auditManifest = bundle.manifestByPath.get(paths.auditPath);
    const outerManifest = bundle.manifestByPath.get(paths.outerPath);
    if (!auditManifest) throw new Error(`Raw archive manifest omitted ${paths.auditPath}`);
    if (!outerManifest) throw new Error(`Raw archive manifest omitted ${paths.outerPath}`);

    const archivedAuditPath = join(bundle.archive.archiveDir, auditManifest.archive_path);
    const archivedOuterPath = join(bundle.archive.archiveDir, outerManifest.archive_path);
    const audit = await parseJsonlFile(archivedAuditPath, paths.auditPath);
    const outer = await readOuterMetadata(archivedOuterPath, paths.outerPath);
    bundle.errors.push(...audit.errors, ...outer.errors);

    const artifacts: CoworkArtifactReference[] = paths.artifactPaths.map((sourcePath) => {
      const manifest = bundle.manifestByPath.get(sourcePath);
      if (!manifest) throw new Error(`Raw archive manifest omitted ${sourcePath}`);
      return {
        source_path: sourcePath,
        archive_path: manifest.archive_path,
        sha256: manifest.sha256,
        size: manifest.size,
      };
    });

    const conversations = normalizeCoworkSession({
        main: bundle.main,
        subagents: bundle.subagents,
        outerMetadata: outer.metadata,
        auditRecords: audit.records,
        auditSidecar: {
          source_path: paths.auditPath,
          archive_path: auditManifest.archive_path,
          archive_manifest_path: bundle.archive.manifestPath,
          sha256: auditManifest.sha256,
        },
        artifacts,
      });
    return {
      conversations: attachRawArchiveManifest(conversations, bundle.archive),
      errors: bundle.errors,
      processedLines: bundle.processedLines,
      sourceFingerprint: bundle.sourceFingerprint,
    };
  },
};
