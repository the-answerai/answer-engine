import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { writeRawArchive } from '../raw-archive.js';
import type {
  ConversationReadResult,
  TranscriptDiscoverOptions,
  TranscriptFile,
  TranscriptReadError,
  TranscriptSource,
} from '../types.js';
import {
  CODEX_ADAPTER_NAME,
  CODEX_ADAPTER_VERSION,
  codexSessionId,
  normalizeCodexSession,
  type CodexParsedRecord,
} from './codex-normalize.js';
import {
  readCodexThreadMetadata,
  type CodexThreadMetadata,
} from './codex-state-db.js';

const SOURCE_ID = 'codex' as const;
const SOURCE_NAME = 'Codex';
const EXCLUDED_FILE_NAMES = new Set(['history.jsonl', 'session_index.jsonl']);
const EXCLUDED_DIRECTORIES = new Set([
  'attachments',
  'generated_images',
  'goals',
  'logs',
  'memories',
  'shell_snapshots',
  'worktrees',
]);

interface ParsedJsonlFile {
  records: CodexParsedRecord[];
  errors: TranscriptReadError[];
  processedLines: number;
}

interface MetadataCache {
  key: string;
  value: Promise<Map<string, CodexThreadMetadata>>;
}

let metadataCache: MetadataCache | undefined;

function expandHome(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return join(homedir(), input.slice(2));
  return input;
}

function codexHome(): string {
  return resolve(expandHome(process.env.CODEX_HOME ?? '~/.codex'));
}

function hasGlobMagic(input: string): boolean {
  return input.includes('*');
}

function globRoot(pattern: string): string {
  const firstMagic = pattern.indexOf('*');
  if (firstMagic === -1) return pattern;
  const prefix = pattern.slice(0, firstMagic);
  const slash = prefix.lastIndexOf('/');
  return slash === -1 ? '.' : prefix.slice(0, slash);
}

async function collectJsonlFiles(root: string, recursive = true): Promise<string[]> {
  const files: string[] = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return files;
    throw error;
  }
  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (recursive && entry.isDirectory()) {
      files.push(...await collectJsonlFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(fullPath);
    }
  }
  return files;
}

async function resolveInputPath(input: string): Promise<string[]> {
  const expanded = resolve(expandHome(input));
  if (hasGlobMagic(expanded)) {
    const root = resolve(globRoot(expanded));
    if (expanded.includes('**') && expanded.endsWith('.jsonl')) {
      return collectJsonlFiles(root);
    }
    const directory = dirname(expanded);
    const namePattern = basename(expanded);
    const [prefix, suffix] = namePattern.split('*');
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return entries
      .filter((entry) => entry.isFile()
        && entry.name.startsWith(prefix ?? '')
        && entry.name.endsWith(suffix ?? ''))
      .map((entry) => join(directory, entry.name));
  }

  let inputStat;
  try {
    inputStat = await stat(expanded);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (inputStat.isDirectory()) return collectJsonlFiles(expanded);
  if (inputStat.isFile()) return [expanded];
  return [];
}

function isRolloutPath(filePath: string): boolean {
  const fileName = basename(filePath).toLowerCase();
  if (!fileName.endsWith('.jsonl') || EXCLUDED_FILE_NAMES.has(fileName)) return false;
  const segments = filePath.split(sep).map((segment) => segment.toLowerCase());
  return !segments.some((segment) => EXCLUDED_DIRECTORIES.has(segment));
}

function isArchivedPath(filePath: string): boolean {
  return filePath.split(sep).some((segment) => segment === 'archived_sessions');
}

async function transcriptFileFromPath(filePath: string): Promise<TranscriptFile | null> {
  const fileStat = await stat(filePath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (!fileStat?.isFile()) return null;
  return {
    path: filePath,
    sourceId: SOURCE_ID,
    identity: `${fileStat.dev}:${fileStat.ino}`,
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function parseJsonlFile(
  readPath: string,
  filePath: string = readPath,
): Promise<ParsedJsonlFile> {
  const buffer = await readFile(readPath);
  const endsWithNewline = buffer.at(-1) === 10;
  const lines = buffer.toString('utf8').split('\n');
  if (endsWithNewline) lines.pop();

  const records: CodexParsedRecord[] = [];
  const errors: TranscriptReadError[] = [];
  let ignoredIncompleteLine = false;
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (!isRecord(value)) {
        errors.push({ filePath, line: index + 1, message: 'JSONL record is not an object' });
        continue;
      }
      records.push({ line: index + 1, value });
    } catch (error) {
      if (!endsWithNewline && index === lines.length - 1) {
        ignoredIncompleteLine = true;
        continue;
      }
      errors.push({
        filePath,
        line: index + 1,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    records,
    errors,
    processedLines: lines.length - (ignoredIncompleteLine ? 1 : 0),
  };
}

async function sha256File(filePath: string): Promise<string> {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function metadataFingerprint(dbPath: string): Promise<string> {
  const parts: string[] = [dbPath];
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      const fileStat = await stat(path);
      parts.push(path, `${fileStat.dev}:${fileStat.ino}:${fileStat.size}:${fileStat.mtimeMs}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      parts.push(path, 'missing');
    }
  }
  return parts.join('\0');
}

async function cachedThreadMetadata(dbPath: string): Promise<Map<string, CodexThreadMetadata>> {
  const key = await metadataFingerprint(dbPath);
  if (metadataCache?.key === key) return metadataCache.value;
  const value = readCodexThreadMetadata(dbPath);
  metadataCache = { key, value };
  try {
    return await value;
  } catch (error) {
    if (metadataCache?.value === value) metadataCache = undefined;
    throw error;
  }
}

function findThreadMetadata(
  metadata: ReadonlyMap<string, CodexThreadMetadata>,
  filePath: string,
  records: readonly CodexParsedRecord[],
): CodexThreadMetadata | undefined {
  const sessionId = codexSessionId(records);
  return metadata.get(filePath)
    ?? metadata.get(resolve(filePath))
    ?? (sessionId ? metadata.get(sessionId) : undefined);
}

export const codexSource: TranscriptSource = {
  id: SOURCE_ID,
  label: SOURCE_NAME,

  async discover(options: TranscriptDiscoverOptions = {}): Promise<TranscriptFile[]> {
    const home = codexHome();
    const inputs = options.paths?.length
      ? options.paths
      : [
          join(home, 'sessions', '**', '*.jsonl'),
          join(home, 'archived_sessions', '*.jsonl'),
        ];
    const paths = new Set<string>();
    for (const input of inputs) {
      for (const filePath of await resolveInputPath(input)) {
        if (isRolloutPath(filePath)) paths.add(filePath);
      }
    }
    const files = await Promise.all([...paths].sort().map(transcriptFileFromPath));
    return files.filter((file): file is TranscriptFile => file !== null);
  },

  fingerprint(file: TranscriptFile): Promise<string> {
    return sha256File(file.path);
  },

  async readConversations(file: TranscriptFile): Promise<ConversationReadResult> {
    const archive = await writeRawArchive([file.path], {
      adapterName: CODEX_ADAPTER_NAME,
      adapterVersion: CODEX_ADAPTER_VERSION,
    });
    const manifest = archive.manifest.files[0];
    if (!manifest) throw new Error(`Raw archive manifest omitted ${file.path}`);
    const parsed = await parseJsonlFile(
      join(archive.archiveDir, manifest.archive_path),
      file.path,
    );
    const metadata = await cachedThreadMetadata(join(codexHome(), 'state_5.sqlite'));
    const threadMeta = findThreadMetadata(metadata, file.path, parsed.records);
    return {
      conversations: normalizeCodexSession({
        records: parsed.records,
        path: file.path,
        sha256: manifest.sha256,
        fallbackTimestamp: manifest.mtime,
        ...(threadMeta ? { threadMeta } : {}),
        archived: isArchivedPath(file.path),
      }),
      errors: parsed.errors,
      processedLines: parsed.processedLines,
      sourceFingerprint: manifest.sha256,
    };
  },
};
