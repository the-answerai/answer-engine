import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { evalResultsDir, evalSetPath } from '../home.js';
import type { EvalArtifact, EvalQuery } from './types.js';

const EvalQuerySchema = z.object({
  id: z.string().trim().min(1).max(120),
  query: z.string().trim().min(1).max(2000),
  relevantContentIds: z.array(z.string().uuid()).min(1),
}).strict();

const SET_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export class EvalStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalStoreError';
  }
}

function validateSetName(name: string): void {
  if (!SET_NAME_PATTERN.test(name)) {
    throw new EvalStoreError('Eval set name must use 1-64 lowercase letters, numbers, dots, dashes, or underscores');
  }
}

export function normalizeEvalQueries(queries: EvalQuery[]): EvalQuery[] {
  const normalized = queries.map((query) => ({
    id: query.id.trim(),
    query: query.query.trim(),
    relevantContentIds: [...new Set(query.relevantContentIds)].sort(),
  })).sort((left, right) => left.id.localeCompare(right.id));
  const ids = new Set<string>();
  for (const query of normalized) {
    const parsed = EvalQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new EvalStoreError(parsed.error.issues.map((issue) => issue.message).join('; '));
    }
    if (ids.has(query.id)) throw new EvalStoreError(`Duplicate query id: ${query.id}`);
    ids.add(query.id);
  }
  if (normalized.length === 0) throw new EvalStoreError('Eval set must contain at least one query');
  return normalized;
}

export function canonicalEvalJsonl(queries: EvalQuery[]): string {
  return `${normalizeEvalQueries(queries).map((query) => JSON.stringify(query)).join('\n')}\n`;
}

export function hashEvalSet(queries: EvalQuery[]): string {
  return createHash('sha256').update(canonicalEvalJsonl(queries)).digest('hex');
}

export function parseEvalJsonl(contents: string, source = 'eval-set.jsonl'): EvalQuery[] {
  const rows: EvalQuery[] = [];
  for (const [index, rawLine] of contents.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw new EvalStoreError(`${basename(source)}:${index + 1}: invalid JSON`);
    }
    const parsed = EvalQuerySchema.safeParse(value);
    if (!parsed.success) {
      const message = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
      throw new EvalStoreError(`${basename(source)}:${index + 1}: ${message}`);
    }
    rows.push(parsed.data);
  }
  return normalizeEvalQueries(rows);
}

async function atomicPrivateWrite(filePath: string, contents: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, contents, { encoding: 'utf8', mode: 0o600 });
  await rename(tempPath, filePath);
}

export async function loadEvalFile(filePath: string): Promise<EvalQuery[]> {
  try {
    return parseEvalJsonl(await readFile(filePath, 'utf8'), filePath);
  } catch (error) {
    if (error instanceof EvalStoreError) throw error;
    throw new EvalStoreError(`Cannot read eval set ${filePath}: ${String(error)}`);
  }
}

export async function loadEvalSet(name: string): Promise<EvalQuery[]> {
  validateSetName(name);
  return loadEvalFile(evalSetPath(name));
}

export async function writeEvalSet(name: string, queries: EvalQuery[]): Promise<string> {
  validateSetName(name);
  const filePath = evalSetPath(name);
  await atomicPrivateWrite(filePath, canonicalEvalJsonl(queries));
  return filePath;
}

export async function writeEvalArtifact(artifact: EvalArtifact): Promise<string> {
  const safeTimestamp = artifact.evaluatedAt.replace(/[^0-9A-Za-z-]/g, '-');
  const filePath = join(evalResultsDir(), `eval-${safeTimestamp}-${artifact.setHash.slice(0, 12)}.json`);
  await atomicPrivateWrite(filePath, `${JSON.stringify(artifact, null, 2)}\n`);
  return filePath;
}
