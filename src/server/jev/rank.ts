import 'server-only';

import type { JevScore } from './state';

// spec/agent.md §2 step 7. Pure. Ranking = relevance descending, ties → the earlier sentence
// (lower index). Selection = the first k of the ranking, re-sorted into document order.
// No coverage/spread rule (clustering accepted, §6).

export function rankScores(scores: readonly JevScore[]): JevScore[] {
  return [...scores].sort((a, b) => b.relevance - a.relevance || a.index - b.index);
}

/** The top k (k clamped to [0, N]) in document order. */
export function topK(scores: readonly JevScore[], k: number): JevScore[] {
  const n = Math.max(0, Math.min(Math.floor(k), scores.length));
  return rankScores(scores)
    .slice(0, n)
    .sort((a, b) => a.index - b.index);
}
