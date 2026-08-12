import { createHash } from 'node:crypto';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import {
  DEFAULT_LOCAL_DIR_MAX_FILE_BYTES,
  LOCAL_DIR_SOURCE_ID,
  type DocumentFile,
  type DocumentImportRow,
  type LocalDirDiscoverOptions,
  type LocalDirSkip,
  type LocalDirSource,
} from '../types.js';

export const LOCAL_DIR_ADAPTER_NAME = 'local-directory';
export const LOCAL_DIR_ADAPTER_VERSION = '1.0.0';
export const DEFAULT_LOCAL_DIR_INCLUDE = [
  '**/*.md',
  '**/*.markdown',
  '**/*.txt',
] as const;

const HARD_EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules']);
const BINARY_SAMPLE_BYTES = 8 * 1024;

function normalizePathForGlob(path: string): string {
  return path.split(sep).join('/').replace(/^\.\//, '');
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

export function globMatches(path: string, glob: string): boolean {
  const pattern = normalizePathForGlob(glob);
  let regex = '^';
  for (let index = 0; index < pattern.length;) {
    const char = pattern[index];
    if (char === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        regex += '(?:.*/)?';
        index += 3;
      } else {
        regex += '.*';
        index += 2;
      }
      continue;
    }
    if (char === '*') {
      regex += '[^/]*';
      index += 1;
      continue;
    }
    if (char === '?') {
      regex += '[^/]';
      index += 1;
      continue;
    }
    if (char === '{') {
      const close = pattern.indexOf('}', index + 1);
      if (close !== -1) {
        const alternatives = pattern
          .slice(index + 1, close)
          .split(',')
          .map(escapeRegex)
          .join('|');
        regex += `(?:${alternatives})`;
        index = close + 1;
        continue;
      }
    }
    regex += escapeRegex(char);
    index += 1;
  }
  regex += '$';
  return new RegExp(regex).test(normalizePathForGlob(path));
}

export function resolveLocalDirInput(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return resolve(homedir(), input.slice(2));
  return resolve(input);
}

function isHidden(name: string): boolean {
  return name.startsWith('.');
}

function isIncluded(relativePath: string, include: readonly string[], exclude: readonly string[]): boolean {
  return include.some((pattern) => globMatches(relativePath, pattern))
    && !exclude.some((pattern) => globMatches(relativePath, pattern));
}

async function looksBinary(path: string): Promise<boolean> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(BINARY_SAMPLE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

function reportSkip(
  options: LocalDirDiscoverOptions,
  path: string,
  reason: LocalDirSkip['reason'],
  size: number,
  maxFileBytes: number,
): void {
  options.onSkip?.({ path, reason, size, maxFileBytes });
}

async function documentFile(
  path: string,
  rootPath: string,
  relativePath: string,
  options: LocalDirDiscoverOptions,
  maxFileBytes: number,
): Promise<DocumentFile | null> {
  const fileStat = await stat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (!fileStat?.isFile()) return null;
  if (fileStat.size > maxFileBytes) {
    reportSkip(options, path, 'too_large', fileStat.size, maxFileBytes);
    return null;
  }
  if (await looksBinary(path)) {
    reportSkip(options, path, 'binary', fileStat.size, maxFileBytes);
    return null;
  }
  return {
    path,
    rootPath,
    relativePath: normalizePathForGlob(relativePath),
    sourceId: LOCAL_DIR_SOURCE_ID,
    identity: `${fileStat.dev}:${fileStat.ino}`,
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
  };
}

async function collectDirectoryFiles(
  rootPath: string,
  directory: string,
  options: LocalDirDiscoverOptions,
  include: readonly string[],
  exclude: readonly string[],
  maxFileBytes: number,
): Promise<DocumentFile[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const files: DocumentFile[] = [];
  for (const entry of entries) {
    if (isHidden(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (HARD_EXCLUDED_DIRECTORIES.has(entry.name)) continue;
      files.push(...await collectDirectoryFiles(
        rootPath,
        path,
        options,
        include,
        exclude,
        maxFileBytes,
      ));
      continue;
    }
    if (!entry.isFile()) continue;
    const relativePath = normalizePathForGlob(relative(rootPath, path));
    if (!isIncluded(relativePath, include, exclude)) continue;
    const file = await documentFile(path, rootPath, relativePath, options, maxFileBytes);
    if (file) files.push(file);
  }
  return files;
}

async function discoverInput(
  input: string,
  options: LocalDirDiscoverOptions,
  include: readonly string[],
  exclude: readonly string[],
  maxFileBytes: number,
): Promise<DocumentFile[]> {
  const path = resolveLocalDirInput(input);
  const inputStat = await stat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (!inputStat) return [];
  if (inputStat.isDirectory()) {
    return collectDirectoryFiles(path, path, options, include, exclude, maxFileBytes);
  }
  if (!inputStat.isFile() || isHidden(basename(path))) return [];
  const relativePath = basename(path);
  if (!isIncluded(relativePath, include, exclude)) return [];
  const file = await documentFile(
    path,
    dirname(path),
    relativePath,
    options,
    maxFileBytes,
  );
  return file ? [file] : [];
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function documentFromBytes(file: DocumentFile, bytes: Buffer): DocumentImportRow {
  const sourceSha256 = sha256(bytes);
  const common = {
    filePath: file.path,
    fileIdentity: file.identity,
    relativePath: file.relativePath,
    sourceIdentifier: `${LOCAL_DIR_SOURCE_ID}:${file.path}`,
    sourceSha256,
    adapterName: LOCAL_DIR_ADAPTER_NAME,
    adapterVersion: LOCAL_DIR_ADAPTER_VERSION,
    title: file.relativePath,
    contentType: 'document' as const,
    raw: {
      path: file.path,
      relative_path: file.relativePath,
      size: file.size,
      mtime_ms: file.mtimeMs,
      file_identity: file.identity,
    },
  };
  const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return { ...common, content };
}

export const localDirSource: LocalDirSource = {
  id: LOCAL_DIR_SOURCE_ID,
  label: 'Local directory',

  async discover(options: LocalDirDiscoverOptions): Promise<DocumentFile[]> {
    const include = options.include?.length ? options.include : DEFAULT_LOCAL_DIR_INCLUDE;
    const exclude = options.exclude ?? [];
    const maxFileBytes = options.maxFileBytes ?? DEFAULT_LOCAL_DIR_MAX_FILE_BYTES;
    const paths = new Map<string, DocumentFile>();
    for (const input of options.paths) {
      for (const file of await discoverInput(input, options, include, exclude, maxFileBytes)) {
        paths.set(file.path, file);
      }
    }
    return [...paths.values()].sort((left, right) => left.path.localeCompare(right.path));
  },

  async readDocuments(file: DocumentFile): Promise<{
    documents: DocumentImportRow[];
    sourceFingerprint: string;
  }> {
    const bytes = await readFile(file.path);
    const document = documentFromBytes(file, bytes);
    return {
      documents: [document],
      sourceFingerprint: document.sourceSha256,
    };
  },
};

export type { LocalDirSkip } from '../types.js';
