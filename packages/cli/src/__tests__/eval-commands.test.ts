import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnswerEngineClient, QueryInput, QueryResultItem } from '../api-client.js';
import { createClient } from '../client.js';
import { registerEvalCommands } from '../commands/eval.js';
import { aggregateMetrics, mrrAt10, recallAtK } from '../eval/metrics.js';
import { runEvaluation } from '../eval/runner.js';
import {
  EvalStoreError,
  loadEvalFile,
  loadEvalSet,
  writeEvalArtifact,
  writeEvalSet,
} from '../eval/store.js';
import type { EvalQuery } from '../eval/types.js';
import { evalResultsDir, evalSetPath } from '../home.js';
import { printError, printJson } from '../output.js';

vi.mock('../client.js', () => ({
  createClient: vi.fn(),
  handleApiError: vi.fn((error: unknown) => {
    throw error;
  }),
}));

vi.mock('../config.js', () => ({
  getConfig: vi.fn(() => ({
    api_key: 'ae_live_test-key-not-recorded',
    api_url: 'http://localhost:5050',
    default_output: 'auto',
  })),
}));

vi.mock('../output.js', () => ({
  isInteractiveOutput: vi.fn(() => false),
  printError: vi.fn(),
  printJson: vi.fn(),
  printSuccess: vi.fn(),
  printWarning: vi.fn(),
}));

const originalAeHome = process.env.AE_HOME;
const originalTimestamp = process.env.AE_EVAL_TIMESTAMP;
const tempDirs: string[] = [];

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  registerEvalCommands(program);
  return program;
}

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ae-eval-'));
  tempDirs.push(dir);
  return dir;
}

function contentId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function evalQueries(count = 10): EvalQuery[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `q-${String(index + 1).padStart(3, '0')}`,
    query: `query ${index + 1}`,
    relevantContentIds: [contentId(index + 1)],
  }));
}

function jsonl(queries: EvalQuery[]): string {
  return `${queries.map((query) => JSON.stringify(query)).join('\n')}\n`;
}

function resultItem(id: string, relevanceScore: number): QueryResultItem {
  return {
    id,
    contentType: 'document',
    title: id,
    textKind: 'compatibility',
    relevanceScore,
    createdAt: '2026-08-11T00:00:00.000Z',
  };
}

function mockEvalClient() {
  const getSchema = vi.fn().mockResolvedValue({
    data: {
      contentTypes: { document: 10 },
      tags: [],
      capabilities: ['semantic-search', 'rerank', 'hybrid-search'],
      dateRange: { earliest: null, latest: null },
    },
  });
  const query = vi.fn().mockImplementation(async (input: QueryInput) => {
    const queryNumber = Number(input.query.split(' ')[1]);
    const relevantId = contentId(queryNumber);
    const wrongId = contentId(500 + queryNumber);
    const results = input.searchType === 'fulltext'
      ? [resultItem(wrongId, 0.9)]
      : input.searchType === 'semantic'
        ? [resultItem(wrongId, 0.9), resultItem(relevantId, 0.8)]
        : [resultItem(relevantId, 1), resultItem(wrongId, 0.5)];
    return {
      data: { results, total: results.length, searchType: input.searchType ?? 'hybrid' },
    };
  });
  const client = { getSchema, query } as unknown as AnswerEngineClient;
  return { client, getSchema, query };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AE_HOME = makeTempDir();
  process.env.AE_EVAL_TIMESTAMP = '2026-08-11T00:00:00.000Z';
  process.exitCode = undefined;
});

afterEach(() => {
  if (originalAeHome === undefined) delete process.env.AE_HOME;
  else process.env.AE_HOME = originalAeHome;
  if (originalTimestamp === undefined) delete process.env.AE_EVAL_TIMESTAMP;
  else process.env.AE_EVAL_TIMESTAMP = originalTimestamp;
  process.exitCode = undefined;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('eval metrics', () => {
  it('matches the offline Recall@k and MRR@10 behavior', () => {
    expect(recallAtK(['a', 'b', 'c'], ['b', 'd'], 2)).toBe(0.5);
    expect(mrrAt10(['x', 'b', 'd'], ['b', 'd'])).toBe(0.5);
    expect(aggregateMetrics([
      { rankedIds: ['a'], relevantIds: ['a'] },
      { rankedIds: ['x'], relevantIds: ['a'] },
    ])).toEqual({ recallAt5: 0.5, recallAt10: 0.5, mrrAt10: 0.5 });
  });
});

describe('eval set storage', () => {
  it('imports, canonicalizes, and privately stores a 10-query JSONL set', async () => {
    const externalPath = join(makeTempDir(), 'judgments.jsonl');
    writeFileSync(externalPath, jsonl(evalQueries().reverse()));

    const imported = await loadEvalFile(externalPath);
    const storedPath = await writeEvalSet('my-library', imported);
    const stored = await loadEvalSet('my-library');

    expect(stored.map((query) => query.id)).toEqual(evalQueries().map((query) => query.id));
    expect(storedPath).toBe(evalSetPath('my-library'));
    expect(statSync(storedPath).mode & 0o777).toBe(0o600);
  });

  it('rejects invalid JSONL with line context, duplicate ids, and unsafe set names', async () => {
    const invalidPath = join(makeTempDir(), 'invalid.jsonl');
    writeFileSync(invalidPath, `${JSON.stringify(evalQueries(1)[0])}\nnot-json\n`);
    await expect(loadEvalFile(invalidPath)).rejects.toThrow(/invalid\.jsonl:2/);

    const duplicatePath = join(makeTempDir(), 'duplicate.jsonl');
    writeFileSync(duplicatePath, jsonl([evalQueries(1)[0], evalQueries(1)[0]]));
    await expect(loadEvalFile(duplicatePath)).rejects.toThrow(/duplicate query id/i);

    const emptyRelevancePath = join(makeTempDir(), 'empty-relevance.jsonl');
    writeFileSync(emptyRelevancePath, `${JSON.stringify({
      id: 'q-empty',
      query: 'empty relevance',
      relevantContentIds: [],
    })}\n`);
    await expect(loadEvalFile(emptyRelevancePath)).rejects.toThrow(/at least 1/i);
    await expect(writeEvalSet('../escape', evalQueries(1))).rejects.toBeInstanceOf(EvalStoreError);
  });
});

describe('eval runner', () => {
  it('runs real query variants in fixed order and emits deterministic honest metadata', async () => {
    const firstClient = mockEvalClient();
    const first = await runEvaluation(firstClient.client, evalQueries().reverse(), {
      apiUrl: 'http://localhost:5050',
      apiKey: 'ae_live_test-key-not-recorded',
      evaluatedAt: process.env.AE_EVAL_TIMESTAMP!,
      librarySlug: 'seeded-library',
      limit: 10,
      setName: 'seeded-ten',
    });
    const secondClient = mockEvalClient();
    const second = await runEvaluation(secondClient.client, evalQueries(), {
      apiUrl: 'http://localhost:5050',
      apiKey: 'ae_live_test-key-not-recorded',
      evaluatedAt: process.env.AE_EVAL_TIMESTAMP!,
      librarySlug: 'seeded-library',
      limit: 10,
      setName: 'seeded-ten',
    });

    expect(first).toEqual(second);
    expect(first.configuration.variants).toEqual(['fulltext', 'semantic', 'hybrid']);
    expect(first.configuration.rerank).toEqual(expect.objectContaining({ advertised: true, evaluated: false }));
    expect(first.configuration.models.embeddingProvider).toBeNull();
    expect(JSON.stringify(first)).not.toContain('test-key-not-recorded');
    expect(first.metrics.fulltext.mrrAt10).toBe(0);
    expect(first.metrics.semantic.mrrAt10).toBe(0.5);
    expect(first.metrics.hybrid.mrrAt10).toBe(1);
    expect(firstClient.getSchema).toHaveBeenCalledTimes(1);
    expect(firstClient.query).toHaveBeenCalledTimes(30);
    expect(firstClient.query.mock.calls.slice(0, 3).map(([input]) => input.searchType)).toEqual([
      'fulltext',
      'semantic',
      'hybrid',
    ]);
    expect(firstClient.query.mock.calls[0][0].query).toBe('query 1');
    expect(firstClient.query).toHaveBeenCalledWith(expect.objectContaining({
      librarySlug: 'seeded-library',
      limit: 10,
      include: [],
    }));

    const firstPath = await writeEvalArtifact(first);
    const firstBytes = readFileSync(firstPath, 'utf8');
    const secondPath = await writeEvalArtifact(second);
    expect(secondPath).toBe(firstPath);
    expect(readFileSync(secondPath, 'utf8')).toBe(firstBytes);
    expect(statSync(secondPath).mode & 0o777).toBe(0o600);
    expect(firstPath.startsWith(evalResultsDir())).toBe(true);
  });

  it('requires enough results to calculate Recall@10 and MRR@10', async () => {
    await expect(runEvaluation(mockEvalClient().client, evalQueries(1), {
      apiUrl: 'http://localhost:5050',
      apiKey: 'ae_live_test',
      evaluatedAt: '2026-08-11T00:00:00.000Z',
      limit: 5,
      setName: null,
    })).rejects.toThrow(/between 10 and 50/);
  });
});

describe('eval commands', () => {
  it('imports a JSONL set without making API calls', async () => {
    const externalPath = join(makeTempDir(), 'judgments.jsonl');
    writeFileSync(externalPath, jsonl(evalQueries()));

    await makeProgram().parseAsync(['node', 'ae', 'eval', 'label', '--set', 'imported', '--file', externalPath]);

    expect(createClient).not.toHaveBeenCalled();
    expect(existsSync(evalSetPath('imported'))).toBe(true);
    expect(printJson).toHaveBeenCalledWith(expect.objectContaining({ set: 'imported', queries: 10 }));
  });

  it('requires exactly one set source for eval run', async () => {
    await makeProgram().parseAsync(['node', 'ae', 'eval', 'run']);
    expect(printError).toHaveBeenCalledWith(expect.stringMatching(/exactly one/i));
    expect(createClient).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('runs a named set and emits one machine-readable payload', async () => {
    await writeEvalSet('seeded-ten', evalQueries());
    const client = mockEvalClient();
    vi.mocked(createClient).mockReturnValue(client.client);

    await makeProgram().parseAsync([
      'node',
      'ae',
      'eval',
      'run',
      '--set',
      'seeded-ten',
      '--library',
      'seeded-library',
      '--limit',
      '10',
    ]);

    expect(printJson).toHaveBeenCalledTimes(1);
    expect(printJson).toHaveBeenCalledWith(expect.objectContaining({
      artifactPath: expect.stringContaining('eval-2026-08-11T00-00-00-000Z-'),
      artifact: expect.objectContaining({
        metrics: expect.objectContaining({
          fulltext: expect.any(Object),
          semantic: expect.any(Object),
          hybrid: expect.any(Object),
        }),
      }),
    }));
  });
});
