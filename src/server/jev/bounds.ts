import 'server-only';

import type { Sentence } from '@/lib/content/types';

import type { JevBounds } from './state';

// spec/agent.md §2 step 1. N = eligible sentences, W = their total words.
// target = clamp(3 + ceil(W / 250), 4, 8); min = min(N, max(4, target - 1)); max = min(N, min(8, target + 1)).
// target is additionally clamped into [min, max] so short articles (N < 4) ask for exactly N.

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

export function computeBounds(sentences: readonly Pick<Sentence, 'words'>[]): JevBounds {
  const n = sentences.length;
  const w = sentences.reduce((sum, s) => sum + s.words, 0);
  const target = clamp(3 + Math.ceil(w / 250), 4, 8);
  const min = Math.min(n, Math.max(4, target - 1));
  const max = Math.min(n, Math.min(8, target + 1));
  return { min, max, target: clamp(target, min, max) };
}
