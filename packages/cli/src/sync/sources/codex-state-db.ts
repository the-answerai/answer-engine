import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export interface CodexThreadMetadata {
  id: string;
  rollout_path?: string;
  title?: string;
  name?: string;
  archived?: boolean;
  git_branch?: string;
  git_origin_url?: string;
  git_sha?: string;
  model?: string;
  reasoning_effort?: string;
  tokens_used?: number;
  cwd?: string;
  created_at?: string | number;
  updated_at?: string | number;
  has_user_event?: boolean;
}

interface SqliteStatement {
  all(...parameters: unknown[]): unknown[];
}

interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface NodeSqliteCandidate {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;
  backup?: (source: SqliteDatabase, destination: string) => Promise<void>;
}

interface NodeSqliteModule extends NodeSqliteCandidate {
  backup(source: SqliteDatabase, destination: string): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') {
    const converted = Number(value);
    return Number.isSafeInteger(converted) ? converted : undefined;
  }
  return undefined;
}

function timestampValue(value: unknown): string | number | undefined {
  return stringValue(value) ?? numberValue(value);
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 0 || value === 0n) return false;
  if (value === 1 || value === 1n) return true;
  return undefined;
}

function rowToMetadata(row: unknown): CodexThreadMetadata | undefined {
  if (!isRecord(row)) return undefined;
  const id = stringValue(row.id);
  if (!id) return undefined;
  const rolloutPath = stringValue(row.rollout_path);
  const title = stringValue(row.title);
  const name = stringValue(row.name);
  const archived = booleanValue(row.archived);
  const gitBranch = stringValue(row.git_branch);
  const gitOriginUrl = stringValue(row.git_origin_url);
  const gitSha = stringValue(row.git_sha);
  const model = stringValue(row.model);
  const reasoningEffort = stringValue(row.reasoning_effort);
  const tokensUsed = numberValue(row.tokens_used);
  const cwd = stringValue(row.cwd);
  const createdAt = timestampValue(row.created_at);
  const updatedAt = timestampValue(row.updated_at);
  const hasUserEvent = booleanValue(row.has_user_event);
  return {
    id,
    ...(rolloutPath ? { rollout_path: rolloutPath } : {}),
    ...(title ? { title } : {}),
    ...(name ? { name } : {}),
    ...(archived !== undefined ? { archived } : {}),
    ...(gitBranch ? { git_branch: gitBranch } : {}),
    ...(gitOriginUrl ? { git_origin_url: gitOriginUrl } : {}),
    ...(gitSha ? { git_sha: gitSha } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    ...(tokensUsed !== undefined ? { tokens_used: tokensUsed } : {}),
    ...(cwd ? { cwd } : {}),
    ...(createdAt !== undefined ? { created_at: createdAt } : {}),
    ...(updatedAt !== undefined ? { updated_at: updatedAt } : {}),
    ...(hasUserEvent !== undefined ? { has_user_event: hasUserEvent } : {}),
  };
}

function loadNodeSqlite(): NodeSqliteModule {
  let sqlite: NodeSqliteCandidate;
  try {
    const require = createRequire(import.meta.url);
    sqlite = require('node:sqlite') as NodeSqliteCandidate;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Codex state metadata requires Node.js 22.16 or newer: ${reason}`);
  }
  if (typeof sqlite.backup !== 'function') {
    throw new Error('Codex state metadata requires Node.js 22.16 or newer: SQLite backup API unavailable');
  }
  return sqlite as NodeSqliteModule;
}

function closeDatabase(database: SqliteDatabase | undefined): void {
  if (!database) return;
  database.close();
}

export async function readCodexThreadMetadata(
  dbPath: string,
): Promise<Map<string, CodexThreadMetadata>> {
  try {
    const dbStat = await stat(dbPath);
    if (!dbStat.isFile()) return new Map();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw error;
  }

  const sqlite = loadNodeSqlite();
  const snapshotDirectory = await mkdtemp(join(tmpdir(), 'ae-codex-state-'));
  const snapshotPath = join(snapshotDirectory, 'state_5.sqlite');
  let sourceDatabase: SqliteDatabase | undefined;
  let snapshotDatabase: SqliteDatabase | undefined;
  try {
    sourceDatabase = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    await sqlite.backup(sourceDatabase, snapshotPath);
    closeDatabase(sourceDatabase);
    sourceDatabase = undefined;

    snapshotDatabase = new sqlite.DatabaseSync(snapshotPath, { readOnly: true });
    let rows: unknown[];
    try {
      rows = snapshotDatabase.prepare('SELECT * FROM threads').all();
    } catch (error) {
      if (error instanceof Error && /no such table:\s*threads/i.test(error.message)) {
        return new Map();
      }
      throw error;
    }

    const metadata = new Map<string, CodexThreadMetadata>();
    for (const row of rows) {
      const thread = rowToMetadata(row);
      if (!thread) continue;
      metadata.set(thread.id, thread);
      if (thread.rollout_path) {
        metadata.set(thread.rollout_path, thread);
        metadata.set(resolve(thread.rollout_path), thread);
      }
    }
    return metadata;
  } finally {
    try {
      closeDatabase(snapshotDatabase);
    } finally {
      try {
        closeDatabase(sourceDatabase);
      } finally {
        await rm(snapshotDirectory, { recursive: true, force: true });
      }
    }
  }
}
