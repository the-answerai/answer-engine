import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { Command } from 'commander';
import type { AnswerEngineClient, QueryResultItem } from '../api-client.js';
import { createClient, handleApiError } from '../client.js';
import { getConfig } from '../config.js';
import { runEvaluation } from '../eval/runner.js';
import {
  EvalStoreError,
  loadEvalFile,
  loadEvalSet,
  writeEvalArtifact,
  writeEvalSet,
} from '../eval/store.js';
import { EVAL_VARIANTS, type EvalArtifact, type EvalQuery } from '../eval/types.js';
import {
  isInteractiveOutput,
  printError,
  printJson,
  printSuccess,
  printWarning,
} from '../output.js';

interface LabelOptions {
  set: string;
  file?: string;
  library?: string;
  limit: string;
}

interface RunOptions {
  set?: string;
  file?: string;
  library?: string;
  limit: string;
}

class EvalCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalCommandError';
  }
}

function parseLimit(raw: string): number {
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 10 || limit > 50) {
    throw new EvalCommandError('--limit must be an integer between 10 and 50');
  }
  return limit;
}

function reportCommandError(error: unknown): void {
  if (error instanceof EvalStoreError || error instanceof EvalCommandError) {
    printError(error.message);
    process.exitCode = 1;
    return;
  }
  handleApiError(error);
}

function stableQueryId(query: string): string {
  return `q-${createHash('sha256').update(query).digest('hex').slice(0, 12)}`;
}

function parseSelections(raw: string, count: number): number[] {
  const selections = [...new Set(raw.split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value >= 1 && value <= count))];
  if (selections.length === 0) {
    throw new EvalCommandError('Select at least one relevant result number');
  }
  return selections;
}

async function collectCandidates(
  client: AnswerEngineClient,
  query: string,
  options: Pick<LabelOptions, 'library' | 'limit'>,
): Promise<QueryResultItem[]> {
  const candidates = new Map<string, QueryResultItem>();
  const limit = parseLimit(options.limit);
  for (const variant of EVAL_VARIANTS) {
    const response = await client.query({
      query,
      searchType: variant,
      limit,
      include: ['summary'],
      ...(options.library ? { librarySlug: options.library } : {}),
    });
    for (const item of response.data.results) {
      if (!candidates.has(item.id)) candidates.set(item.id, item);
    }
  }
  return [...candidates.values()];
}

async function labelInteractively(client: AnswerEngineClient, options: LabelOptions): Promise<EvalQuery[]> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new EvalCommandError('Interactive labeling requires a TTY; use --file <jsonl> to import judgments');
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const queries: EvalQuery[] = [];
  try {
    process.stdout.write('Enter queries one at a time. Submit a blank query to finish.\n');
    while (true) {
      const query = (await rl.question('\nQuery: ')).trim();
      if (!query) break;
      const candidates = await collectCandidates(client, query, options);
      if (candidates.length === 0) {
        printWarning('No candidates returned; query was not added.');
        continue;
      }
      for (const [index, candidate] of candidates.entries()) {
        const summary = candidate.summary ? ` — ${candidate.summary.slice(0, 120)}` : '';
        process.stdout.write(`${index + 1}. ${candidate.title} [${candidate.id}]${summary}\n`);
      }
      const selected = parseSelections(
        await rl.question('Relevant result numbers (comma-separated): '),
        candidates.length,
      );
      queries.push({
        id: stableQueryId(query),
        query,
        relevantContentIds: selected.map((number) => candidates[number - 1].id),
      });
    }
  } finally {
    rl.close();
  }
  return queries;
}

function printScorecard(artifact: EvalArtifact, artifactPath: string): void {
  process.stdout.write('Configuration  Recall@5  Recall@10  MRR@10\n');
  process.stdout.write('---------------------------------------------\n');
  for (const variant of EVAL_VARIANTS) {
    const metrics = artifact.metrics[variant];
    process.stdout.write(
      `${variant.padEnd(13)} ${metrics.recallAt5.toFixed(4).padStart(8)}  `
      + `${metrics.recallAt10.toFixed(4).padStart(9)}  ${metrics.mrrAt10.toFixed(4).padStart(6)}\n`,
    );
  }
  process.stdout.write(`\nArtifact: ${artifactPath}\n`);
  if (artifact.configuration.rerank.advertised) {
    printWarning(`Rerank was advertised but not evaluated: ${artifact.configuration.rerank.reason}`);
  }
}

export function registerEvalCommands(program: Command): void {
  const evalCommand = program.command('eval').description('Label and run retrieval scorecards on your library');

  evalCommand
    .command('label')
    .description('Create a relevance set interactively or import JSONL judgments')
    .requiredOption('--set <name>', 'Local eval set name')
    .option('--file <jsonl>', 'Import labeled query-to-relevant-id judgments')
    .option('--library <slug>', 'Restrict candidate retrieval to a library')
    .option('--limit <n>', 'Candidates per retrieval variant (10-50)', '10')
    .action(async (options: LabelOptions) => {
      try {
        const queries = options.file
          ? await loadEvalFile(options.file)
          : await labelInteractively(createClient(), options);
        const setPath = await writeEvalSet(options.set, queries);
        if (isInteractiveOutput()) printSuccess(`Saved ${queries.length} judgments to ${setPath}`);
        else printJson({ set: options.set, queries: queries.length, path: setPath });
      } catch (error) {
        reportCommandError(error);
      }
    });

  evalCommand
    .command('run')
    .description('Score a named or external relevance set across live retrieval variants')
    .option('--set <name>', 'Load a set from AE_HOME/eval/sets')
    .option('--file <jsonl>', 'Load an external JSONL relevance set')
    .option('--library <slug>', 'Restrict retrieval to a library')
    .option('--limit <n>', 'Results per retrieval variant (10-50)', '10')
    .action(async (options: RunOptions) => {
      try {
        if (Boolean(options.set) === Boolean(options.file)) {
          throw new EvalCommandError('Provide exactly one of --set <name> or --file <jsonl>');
        }
        const limit = parseLimit(options.limit);
        const queries = options.set
          ? await loadEvalSet(options.set)
          : await loadEvalFile(options.file!);
        const config = getConfig();
        const artifact = await runEvaluation(createClient(), queries, {
          apiUrl: config.api_url,
          apiKey: config.api_key,
          evaluatedAt: process.env.AE_EVAL_TIMESTAMP ?? new Date().toISOString(),
          librarySlug: options.library,
          limit,
          setName: options.set ?? null,
        });
        const artifactPath = await writeEvalArtifact(artifact);
        if (isInteractiveOutput()) printScorecard(artifact, artifactPath);
        else printJson({ artifactPath, artifact });
      } catch (error) {
        reportCommandError(error);
      }
    });
}
