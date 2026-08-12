import type { RelevanceMetrics } from './metrics.js';

export const EVAL_VARIANTS = ['fulltext', 'semantic', 'hybrid'] as const;

export type EvalVariant = typeof EVAL_VARIANTS[number];

export interface EvalQuery {
  id: string;
  query: string;
  relevantContentIds: string[];
}

export interface EvalQueryResult extends EvalQuery {
  rankedIds: Record<EvalVariant, string[]>;
  metrics: Record<EvalVariant, RelevanceMetrics>;
}

export interface EvalArtifact {
  schemaVersion: 1;
  evaluatedAt: string;
  setName: string | null;
  setHash: string;
  configuration: {
    apiUrl: string;
    authentication: {
      method: 'api-key';
      keyKind: 'ae_live' | 'ae_test' | 'unknown';
      surface: 'cli';
    };
    librarySlug: string | null;
    capabilities: string[];
    variants: EvalVariant[];
    limit: number;
    rerank: {
      advertised: boolean;
      evaluated: false;
      reason: string;
    };
    models: {
      embeddingProvider: null;
      embeddingModel: null;
      rerankProvider: null;
      rerankModel: null;
      source: 'not_reported_by_agent_schema';
    };
  };
  metrics: Record<EvalVariant, RelevanceMetrics>;
  perQuery: EvalQueryResult[];
}
