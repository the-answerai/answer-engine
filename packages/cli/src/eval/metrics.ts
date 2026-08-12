/** Ported from evals/metrics.ts — keep in sync. */
export interface RelevanceMetrics {
  recallAt5: number;
  recallAt10: number;
  mrrAt10: number;
}

export interface RankedJudgment {
  rankedIds: string[];
  relevantIds: string[];
}

export function recallAtK(rankedIds: string[], relevantIds: string[], k: number): number {
  if (relevantIds.length === 0) throw new Error('Recall requires at least one relevant id');
  if (!Number.isInteger(k) || k < 1) throw new Error('Recall k must be a positive integer');
  const relevant = new Set(relevantIds);
  const retrieved = new Set(rankedIds.slice(0, k));
  let hits = 0;
  for (const id of relevant) {
    if (retrieved.has(id)) hits += 1;
  }
  return hits / relevant.size;
}

export function mrrAt10(rankedIds: string[], relevantIds: string[]): number {
  if (relevantIds.length === 0) throw new Error('MRR requires at least one relevant id');
  const relevant = new Set(relevantIds);
  const index = rankedIds.slice(0, 10).findIndex((id) => relevant.has(id));
  return index === -1 ? 0 : 1 / (index + 1);
}

export function aggregateMetrics(judgments: RankedJudgment[]): RelevanceMetrics {
  if (judgments.length === 0) throw new Error('At least one query judgment is required');
  const totals = judgments.reduce<RelevanceMetrics>(
    (sum, judgment) => ({
      recallAt5: sum.recallAt5 + recallAtK(judgment.rankedIds, judgment.relevantIds, 5),
      recallAt10: sum.recallAt10 + recallAtK(judgment.rankedIds, judgment.relevantIds, 10),
      mrrAt10: sum.mrrAt10 + mrrAt10(judgment.rankedIds, judgment.relevantIds),
    }),
    { recallAt5: 0, recallAt10: 0, mrrAt10: 0 },
  );
  return {
    recallAt5: totals.recallAt5 / judgments.length,
    recallAt10: totals.recallAt10 / judgments.length,
    mrrAt10: totals.mrrAt10 / judgments.length,
  };
}
