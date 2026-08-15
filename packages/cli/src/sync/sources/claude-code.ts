import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import {
  attachRawArchiveManifest,
  writeRawArchive,
  type RawFileManifestEntry,
  type WriteRawArchiveResult,
} from '../raw-archive.js';
import type {
  ChatTurn,
  ChatTurnRole,
  ConversationReadResult,
  FileCursor,
  TranscriptDiscoverOptions,
  TranscriptFile,
  TranscriptReadError,
  TranscriptReadResult,
  TranscriptSource,
} from '../types.js';
import {
  CLAUDE_CODE_ADAPTER_NAME,
  CLAUDE_CODE_ADAPTER_VERSION,
  normalizeClaudeCodeSession,
  type ClaudeCodeParsedRecord,
  type ClaudeCodeStream,
} from './claude-code-normalize.js';

const DEFAULT_CLAUDE_CODE_GLOB = '~/.claude/projects/**/*.jsonl';
const SOURCE_ID = 'claude-code' as const;
const SOURCE_NAME = 'Claude Code';
const SOURCE_AGENT_ID = 'claude' as const;
const SOURCE_AGENT_LABEL = 'Claude';

function expandHome(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return join(homedir(), input.slice(2));
  return input;
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

async function collectJsonlFiles(root: string): Promise<string[]> {
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
    if (entry.isDirectory()) {
      files.push(...await collectJsonlFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(fullPath);
    }
  }
  return files;
}

export function isMainTranscriptPath(filePath: string): boolean {
  const name = basename(filePath).toLowerCase();
  if (!name.endsWith('.jsonl')) return false;
  if (name === 'audit.jsonl' || name === 'history.jsonl' || name.startsWith('agent-')) {
    return false;
  }
  return !filePath.split(sep).includes('subagents');
}

export async function resolveInputPath(input: string): Promise<string[]> {
  const expanded = resolve(expandHome(input));
  if (hasGlobMagic(expanded)) {
    const root = resolve(globRoot(expanded));
    if (expanded.includes('**') && expanded.endsWith('.jsonl')) {
      return collectJsonlFiles(root);
    }

    const dir = dirname(expanded);
    const namePattern = basename(expanded);
    const [prefix, suffix] = namePattern.split('*');
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return entries
      .filter((entry) =>
        entry.isFile() &&
        entry.name.startsWith(prefix ?? '') &&
        entry.name.endsWith(suffix ?? '')
      )
      .map((entry) => join(dir, entry.name));
  }

  let stats;
  try {
    stats = await stat(expanded);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  if (stats.isDirectory()) return collectJsonlFiles(expanded);
  if (stats.isFile()) return [expanded];
  return [];
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function getNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function compactObject(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) =>
      value !== undefined &&
      value !== null &&
      !(typeof value === 'string' && value.length === 0)
    )
  );
}

function stringifyBlock(block: unknown): string {
  if (typeof block === 'string') return block;
  if (!isRecord(block)) return stringifyUnknown(block);

  const type = getString(block, 'type');
  if (type === 'text') return getString(block, 'text') ?? '';
  if (type === 'tool_use') {
    const name = getString(block, 'name') ?? 'tool';
    const input = block.input === undefined ? '' : ` ${stringifyUnknown(block.input)}`;
    return `[tool_use:${name}]${input}`;
  }
  if (type === 'tool_result') {
    const toolUseId = getString(block, 'tool_use_id') ?? getString(block, 'id') ?? 'unknown';
    const content = block.content === undefined ? '' : stringifyUnknown(block.content);
    return `[tool_result:${toolUseId}] ${content}`;
  }

  return stringifyUnknown(block);
}

function stringifyUnknown(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(stringifyBlock).filter(Boolean).join('\n');
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractContent(record: Record<string, unknown>, message: Record<string, unknown> | undefined): string {
  const candidates = [
    message?.content,
    record.content,
    record.text,
    record.summary,
  ];

  for (const candidate of candidates) {
    const content = stringifyUnknown(candidate).trim();
    if (content) return content;
  }
  return '';
}

function contentIsToolResult(message: Record<string, unknown> | undefined): boolean {
  const content = message?.content;
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every((block) => isRecord(block) && getString(block, 'type') === 'tool_result');
}

function normalizeRole(
  record: Record<string, unknown>,
  message: Record<string, unknown> | undefined
): ChatTurnRole {
  if (contentIsToolResult(message)) return 'tool';

  const raw = (
    getString(message ?? {}, 'role') ??
    getString(record, 'role') ??
    getString(record, 'type') ??
    'other'
  ).toLowerCase();

  if (raw === 'human') return 'user';
  if (raw === 'ai') return 'assistant';
  if (raw === 'summary') return 'system';
  if (raw === 'user' || raw === 'assistant' || raw === 'system' || raw === 'tool' || raw === 'developer') {
    return raw;
  }
  return 'other';
}

function normalizeTimestamp(record: Record<string, unknown>, message: Record<string, unknown> | undefined): string | undefined {
  const raw =
    getString(record, 'timestamp') ??
    getString(record, 'createdAt') ??
    getString(record, 'created_at') ??
    getString(message ?? {}, 'created_at');
  if (!raw || Number.isNaN(Date.parse(raw))) return undefined;
  return new Date(raw).toISOString();
}

function titleForTurn(role: ChatTurnRole, content: string, turnIndex: number): string {
  const snippet = content.replace(/\s+/g, ' ').trim().slice(0, 80);
  return snippet ? `Claude Code ${role}: ${snippet}` : `Claude Code ${role} turn ${turnIndex}`;
}

function fileConversationId(filePath: string): string {
  return basename(filePath).replace(/\.jsonl$/i, '');
}

function turnFromRecord(
  record: Record<string, unknown>,
  file: TranscriptFile,
  lineNumber: number
): ChatTurn | null {
  const message = isRecord(record.message) ? record.message : undefined;
  const content = extractContent(record, message);
  if (!content) return null;

  const conversationId =
    getString(record, 'sessionId') ??
    getString(record, 'conversationId') ??
    getString(record, 'conversation_id') ??
    fileConversationId(file.path);
  const uuid = getString(record, 'uuid') ?? getString(record, 'id');
  const turnKey = uuid ?? `line-${lineNumber}`;
  const turnIndex = getNumber(record, 'turnIndex') ?? getNumber(record, 'turn_index') ?? lineNumber - 1;
  const role = normalizeRole(record, message);
  const timestamp = normalizeTimestamp(record, message);
  const sourceIdentifier = `${SOURCE_ID}:${conversationId}:${turnKey}`;

  return {
    sourceId: SOURCE_ID,
    sourceName: SOURCE_NAME,
    sourceAgentId: SOURCE_AGENT_ID,
    sourceAgentLabel: SOURCE_AGENT_LABEL,
    filePath: file.path,
    fileIdentity: file.identity,
    conversationId,
    turnIndex,
    turnKey,
    sourceIdentifier,
    role,
    timestamp,
    title: titleForTurn(role, content, turnIndex),
    content,
    metadata: compactObject({
      uuid,
      parentUuid: getString(record, 'parentUuid'),
      rawType: getString(record, 'type'),
      cwd: getString(record, 'cwd'),
      gitBranch: getString(record, 'gitBranch'),
      version: getString(record, 'version'),
      model: getString(message ?? {}, 'model') ?? getString(record, 'model'),
      requestId: getString(record, 'requestId') ?? getString(record, 'request_id'),
      line: lineNumber,
      filePath: file.path,
      fileIdentity: file.identity,
    }),
    raw: record,
  };
}

function completeJsonlSlice(buffer: Buffer): Buffer {
  const lastNewline = buffer.lastIndexOf(10);
  if (lastNewline === -1) return Buffer.alloc(0);
  return buffer.subarray(0, lastNewline + 1);
}

export interface ParsedJsonlFile {
  records: ClaudeCodeParsedRecord[];
  errors: TranscriptReadError[];
  processedLines: number;
}

export interface SubagentArtifact {
  path: string;
  metaPath?: string;
  agentId: string;
}

export async function parseJsonlFile(
  readPath: string,
  filePath: string = readPath,
): Promise<ParsedJsonlFile> {
  const buffer = await readFile(readPath);
  const endsWithNewline = buffer.at(-1) === 10;
  const lines = buffer.toString('utf8').split('\n');
  if (endsWithNewline) lines.pop();

  const records: ClaudeCodeParsedRecord[] = [];
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

export async function findSubagentArtifacts(sessionPath: string): Promise<SubagentArtifact[]> {
  const sessionDirectory = join(dirname(sessionPath), fileConversationId(sessionPath));
  const subagentDirectory = join(sessionDirectory, 'subagents');
  let entries;
  try {
    entries = await readdir(subagentDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const names = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  return [...names]
    .filter((name) => /^agent-.+\.jsonl$/i.test(name))
    .sort()
    .map((name) => {
      const agentId = name.replace(/^agent-/, '').replace(/\.jsonl$/i, '');
      const metaName = `agent-${agentId}.meta.json`;
      return {
        path: join(subagentDirectory, name),
        ...(names.has(metaName) ? { metaPath: join(subagentDirectory, metaName) } : {}),
        agentId,
      };
    });
}

async function readMetadata(
  readPath: string,
  filePath: string = readPath,
): Promise<{ metadata: Record<string, unknown>; errors: TranscriptReadError[] }> {
  try {
    const parsed = JSON.parse(await readFile(readPath, 'utf8')) as unknown;
    if (!isRecord(parsed)) {
      return {
        metadata: {},
        errors: [{ filePath, line: 1, message: 'Metadata is not an object' }],
      };
    }
    return { metadata: parsed, errors: [] };
  } catch (error) {
    return {
      metadata: {},
      errors: [{
        filePath,
        line: 1,
        message: error instanceof Error ? error.message : String(error),
      }],
    };
  }
}

async function streamForArtifact(
  path: string,
  sha256: string,
  fallbackConversationId: string,
  fallbackTimestamp: string,
  parsed: ParsedJsonlFile,
  options: { agentId?: string; metadata?: Record<string, unknown> } = {},
): Promise<ClaudeCodeStream> {
  return {
    path,
    sha256,
    fallbackConversationId,
    fallbackTimestamp,
    records: parsed.records,
    ...options,
  };
}

export async function sourceBundlePaths(
  sessionPath: string,
  extraPaths: readonly string[] = [],
): Promise<string[]> {
  const subagents = await findSubagentArtifacts(sessionPath);
  return [...new Set([
    sessionPath,
    ...subagents.flatMap((subagent) => [
      subagent.path,
      ...(subagent.metaPath ? [subagent.metaPath] : []),
    ]),
    ...[...extraPaths].sort(),
  ])];
}

export async function sourceBundleFingerprint(
  sessionPath: string,
  extraPaths: readonly string[] = [],
): Promise<string> {
  const hash = createHash('sha256');
  for (const path of await sourceBundlePaths(sessionPath, extraPaths)) {
    hash.update(path);
    hash.update('\0');
    hash.update(await readFile(path));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function archivedBundleFingerprint(archive: WriteRawArchiveResult): Promise<string> {
  const hash = createHash('sha256');
  for (const entry of archive.manifest.files) {
    hash.update(entry.path);
    hash.update('\0');
    hash.update(await readFile(join(archive.archiveDir, entry.archive_path)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export interface ReadClaudeCodeSessionBundleOptions {
  adapterName: string;
  adapterVersion: string;
  extraPaths?: readonly string[];
}

export interface ClaudeCodeSessionBundle {
  archive: WriteRawArchiveResult;
  manifestByPath: ReadonlyMap<string, RawFileManifestEntry>;
  main: ClaudeCodeStream;
  subagents: ClaudeCodeStream[];
  errors: TranscriptReadError[];
  processedLines: number;
  sourceFingerprint: string;
}

export async function readClaudeCodeSessionBundle(
  sessionPath: string,
  options: ReadClaudeCodeSessionBundleOptions,
): Promise<ClaudeCodeSessionBundle> {
  const subagentArtifacts = await findSubagentArtifacts(sessionPath);
  const sourcePaths = await sourceBundlePaths(sessionPath, options.extraPaths);
  const archive = await writeRawArchive(sourcePaths, {
    adapterName: options.adapterName,
    adapterVersion: options.adapterVersion,
  });
  const manifestByPath = new Map(
    archive.manifest.files.map((entry) => [entry.path, entry]),
  );
  const mainManifest = manifestByPath.get(sessionPath);
  if (!mainManifest) throw new Error(`Raw archive manifest omitted ${sessionPath}`);
  const mainParsed = await parseJsonlFile(
    join(archive.archiveDir, mainManifest.archive_path),
    sessionPath,
  );
  const errors = [...mainParsed.errors];
  const main = await streamForArtifact(
    sessionPath,
    mainManifest.sha256,
    fileConversationId(sessionPath),
    mainManifest.mtime,
    mainParsed,
  );

  const subagents: ClaudeCodeStream[] = [];
  for (const artifact of subagentArtifacts) {
    const manifest = manifestByPath.get(artifact.path);
    if (!manifest) throw new Error(`Raw archive manifest omitted ${artifact.path}`);
    const parsed = await parseJsonlFile(
      join(archive.archiveDir, manifest.archive_path),
      artifact.path,
    );
    errors.push(...parsed.errors);
    let metadata: Record<string, unknown> = {};
    if (artifact.metaPath) {
      const metadataManifest = manifestByPath.get(artifact.metaPath);
      if (!metadataManifest) {
        throw new Error(`Raw archive manifest omitted ${artifact.metaPath}`);
      }
      const metadataResult = await readMetadata(
        join(archive.archiveDir, metadataManifest.archive_path),
        artifact.metaPath,
      );
      metadata = metadataResult.metadata;
      errors.push(...metadataResult.errors);
    }
    subagents.push(await streamForArtifact(
      artifact.path,
      manifest.sha256,
      `${fileConversationId(sessionPath)}:agent:${artifact.agentId}`,
      manifest.mtime,
      parsed,
      { agentId: artifact.agentId, metadata },
    ));
  }

  return {
    archive,
    manifestByPath,
    main,
    subagents,
    errors,
    processedLines: mainParsed.processedLines,
    sourceFingerprint: await archivedBundleFingerprint(archive),
  };
}

interface LaunchMetadataArtifact {
  path: string;
}

const launchMetadataByTranscriptPath = new Map<string, LaunchMetadataArtifact | null>();

function claudeDesktopHome(): string {
  return resolve(expandHome(
    process.env.CLAUDE_DESKTOP_HOME
      ?? '~/Library/Application Support/Claude',
  ));
}

async function loadLaunchMetadataIndex(): Promise<Map<string, LaunchMetadataArtifact>> {
  const directory = join(claudeDesktopHome(), 'claude-code-sessions');
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw error;
  }

  const index = new Map<string, LaunchMetadataArtifact>();
  for (const entry of entries
    .filter((candidate) => candidate.isFile() && candidate.name.endsWith('.json'))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
      if (!isRecord(parsed)) continue;
      const cliSessionId = getString(parsed, 'cliSessionId');
      if (cliSessionId && !index.has(cliSessionId)) {
        index.set(cliSessionId, { path });
      }
    } catch {
      // Launch metadata is optional. Invalid sidecars must not block host history.
    }
  }
  return index;
}

async function launchMetadataForTranscript(
  transcriptPath: string,
): Promise<LaunchMetadataArtifact | null> {
  if (launchMetadataByTranscriptPath.has(transcriptPath)) {
    return launchMetadataByTranscriptPath.get(transcriptPath) ?? null;
  }
  const metadata = (await loadLaunchMetadataIndex()).get(fileConversationId(transcriptPath))
    ?? null;
  launchMetadataByTranscriptPath.set(transcriptPath, metadata);
  return metadata;
}

export const claudeCodeSource: TranscriptSource = {
  id: SOURCE_ID,
  label: SOURCE_NAME,

  async discover(options: TranscriptDiscoverOptions = {}): Promise<TranscriptFile[]> {
    const inputs = options.paths?.length ? options.paths : [DEFAULT_CLAUDE_CODE_GLOB];
    const paths = new Set<string>();
    for (const input of inputs) {
      for (const filePath of await resolveInputPath(input)) {
        if (
          isMainTranscriptPath(filePath)
          && !filePath.split(sep).includes('local-agent-mode-sessions')
        ) {
          paths.add(filePath);
        }
      }
    }

    const files = await Promise.all([...paths].sort().map(transcriptFileFromPath));
    const discovered = files.filter((file): file is TranscriptFile => file !== null);
    if (options.inventoryOnly) return discovered;
    const launchMetadata = await loadLaunchMetadataIndex();
    for (const file of discovered) {
      launchMetadataByTranscriptPath.set(
        file.path,
        launchMetadata.get(fileConversationId(file.path)) ?? null,
      );
    }
    return discovered;
  },

  async fingerprint(file: TranscriptFile): Promise<string> {
    const launchMetadata = await launchMetadataForTranscript(file.path);
    return sourceBundleFingerprint(
      file.path,
      launchMetadata ? [launchMetadata.path] : [],
    );
  },

  async readConversations(file: TranscriptFile): Promise<ConversationReadResult> {
    const launchMetadata = await launchMetadataForTranscript(file.path);
    const bundle = await readClaudeCodeSessionBundle(file.path, {
      adapterName: CLAUDE_CODE_ADAPTER_NAME,
      adapterVersion: CLAUDE_CODE_ADAPTER_VERSION,
      ...(launchMetadata ? { extraPaths: [launchMetadata.path] } : {}),
    });
    let archivedLaunchMetadata: Record<string, unknown> | undefined;
    if (launchMetadata) {
      const manifest = bundle.manifestByPath.get(launchMetadata.path);
      if (!manifest) {
        throw new Error(`Raw archive manifest omitted ${launchMetadata.path}`);
      }
      const parsed = await readMetadata(
        join(bundle.archive.archiveDir, manifest.archive_path),
        launchMetadata.path,
      );
      bundle.errors.push(...parsed.errors);
      if (Object.keys(parsed.metadata).length > 0) {
        archivedLaunchMetadata = parsed.metadata;
      }
    }

    const conversations = normalizeClaudeCodeSession(
        { main: bundle.main, subagents: bundle.subagents },
        archivedLaunchMetadata
          ? { extraParentMetadata: { launch_metadata: archivedLaunchMetadata } }
          : {},
      );
    return {
      conversations: attachRawArchiveManifest(conversations, bundle.archive),
      errors: bundle.errors,
      processedLines: bundle.processedLines,
      sourceFingerprint: bundle.sourceFingerprint,
    };
  },

  async readNewTurns(file: TranscriptFile, cursor: FileCursor): Promise<TranscriptReadResult> {
    const buffer = await readFile(file.path);
    const startOffset = cursor.offset > buffer.length ? 0 : cursor.offset;
    const startLine = cursor.offset > buffer.length ? 0 : cursor.line;
    const completeSlice = completeJsonlSlice(buffer.subarray(startOffset));
    const nextOffset = startOffset + completeSlice.length;
    const lines = completeSlice.toString('utf8').split('\n');
    if (lines[lines.length - 1] === '') lines.pop();

    const turns: ChatTurn[] = [];
    const errors: TranscriptReadError[] = [];

    for (const [index, rawLine] of lines.entries()) {
      const line = rawLine.replace(/\r$/, '');
      const lineNumber = startLine + index + 1;
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!isRecord(parsed)) {
          errors.push({ filePath: file.path, line: lineNumber, message: 'JSONL record is not an object' });
          continue;
        }
        const turn = turnFromRecord(parsed, file, lineNumber);
        if (turn) turns.push(turn);
      } catch (error) {
        errors.push({
          filePath: file.path,
          line: lineNumber,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      turns,
      nextCursor: {
        offset: nextOffset,
        line: startLine + lines.length,
        importedCount: cursor.importedCount,
        skippedCount: cursor.skippedCount + errors.length,
        fileSize: file.size,
        lastMtimeMs: file.mtimeMs,
        fileIdentity: file.identity,
        lastImportedSourceIdentifier: turns.at(-1)?.sourceIdentifier ?? cursor.lastImportedSourceIdentifier,
      },
      errors,
      processedLines: lines.length,
    };
  },
};
