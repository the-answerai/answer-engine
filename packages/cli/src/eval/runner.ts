import type { AnswerEngineClient } from '../api-client.js';
import { aggregateMetrics, mrrAt10, recallAtK, type RelevanceMetrics } from './metrics.js';
import { hashEvalSet, normalizeEvalQueries } from './store.js';
import {
  EVAL_VARIANTS,
  type EvalArtifact,
  type EvalQuery,
  type EvalQueryResult,
  type EvalVariant,
} from './types.js';

type EvalClient = Pick<AnswerEngineClient, 'getSchema' | 'query'>;

export interface RunEvaluationOptions {
  apiUrl: string;
  apiKey: string;
  evaluatedAt: string;
  librarySlug?: string;
  limit: number;
  setName: string | null;
}

function perQueryMetrics(rankedIds: string[], relevantIds: string[]): RelevanceMetrics {
  return {
    recallAt5: recallAtK(rankedIds, relevantIds, 5),
    recallAt10: recallAtK(rankedIds, relevantIds, 10),
    mrrAt10: mrrAt10(rankedIds, relevantIds),
  };
}

function keyKind(apiKey: string): 'ae_live' | 'ae_test' | 'unknown' {
  if (apiKey.startsWith('ae_live_')) return 'ae_live';
  if (apiKey.startsWith('ae_test_')) return 'ae_test';
  return 'unknown';
}

export async function runEvaluation(
  client: EvalClient,
  inputQueries: EvalQuery[],
  options: RunEvaluationOptions,
): Promise<EvalArtifact> {
  if (!Number.isInteger(options.limit) || options.limit < 10 || options.limit > 50) {
    throw new Error('Eval limit must be an integer between 10 and 50');
  }
  const queries = normalizeEvalQueries(inputQueries);
  const schema = await client.getSchema();
  const capabilities = [...new Set(schema.data.capabilities)].sort();
  const perQuery: EvalQueryResult[] = [];

  for (const query of queries) {
    const rankedIds = {} as Record<EvalVariant, string[]>;
    const metrics = {} as Record<EvalVariant, RelevanceMetrics>;
    for (const variant of EVAL_VARIANTS) {
      const response = await client.query({
        query: query.query,
        searchType: variant,
        limit: options.limit,
        include: [],
        ...(options.librarySlug ? { librarySlug: options.librarySlug } : {}),
      });
      rankedIds[variant] = [...new Set(response.data.results.map((item) => item.id))];
      metrics[variant] = perQueryMetrics(rankedIds[variant], query.relevantContentIds);
    }
    perQuery.push({ ...query, rankedIds, metrics });
  }

  const metrics = Object.fromEntries(EVAL_VARIANTS.map((variant) => [
    variant,
    aggregateMetrics(perQuery.map((result) => ({
      rankedIds: result.rankedIds[variant],
      relevantIds: result.relevantContentIds,
    }))),
  ])) as Record<EvalVariant, RelevanceMetrics>;

  return {
    schemaVersion: 1,
    evaluatedAt: options.evaluatedAt,
    setName: options.setName,
    setHash: hashEvalSet(queries),
    configuration: {
      apiUrl: options.apiUrl.replace(/\/+$/, ''),
      authentication: { method: 'api-key', keyKind: keyKind(options.apiKey), surface: 'cli' },
      librarySlug: options.librarySlug ?? null,
      capabilities,
      variants: [...EVAL_VARIANTS],
      limit: options.limit,
      rerank: {
        advertised: capabilities.includes('rerank'),
        evaluated: false,
        reason: 'POST /api/v1/agent/query has no rerank control',
      },
      models: {
        embeddingProvider: null,
        embeddingModel: null,
        rerankProvider: null,
        rerankModel: null,
        source: 'not_reported_by_agent_schema',
      },
    },
    metrics,
    perQuery,
  };
}
