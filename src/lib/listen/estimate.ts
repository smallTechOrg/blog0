// Estimated Listen timing (spec/architecture.md §9.4; rules in spec/capabilities/listen-sync.md →
// Business Rules). Pure + isomorphic. The server resolves reader marks per request from the
// PUBLISHED revision's paragraphs and the published recording's duration; nothing here is stored.

import { validateMarks, type Mark } from './marks';

/** Assumed reading pace (words per minute). */
export const ASSUMED_WPM = 150;
/** Assumed pause after each paragraph (ms). */
export const PARAGRAPH_PAUSE_MS = 600;
/** The pause expressed in word-equivalents at the assumed pace: 600 × 150 / 60 000 = 1.5. */
export const PAUSE_WORDS = (PARAGRAPH_PAUSE_MS * ASSUMED_WPM) / 60_000;

export interface TimedParagraph {
  pid: string;
  words: number;
}

export type ListenTiming = 'synced' | 'estimated';

const WORDY = /[\p{L}\p{N}]/u;

/** Whitespace-separated tokens containing at least one letter or digit. */
export function countWords(text: string): number {
  let n = 0;
  for (const token of text.split(/\s+/)) {
    if (token !== '' && WORDY.test(token)) n++;
  }
  return n;
}

/** pid + countWords(text), in input order. */
export function toTimedParagraphs(paragraphs: readonly { pid: string; text: string }[]): TimedParagraph[] {
  return paragraphs.map((p) => ({ pid: p.pid, words: countWords(p.text) }));
}

/**
 * One mark per paragraph: tMs_i = floor(D × C_i / W), where w_i = max(0, words_i) + PAUSE_WORDS,
 * C_i = w_0 + … + w_{i−1}, W = Σ w and D = floor(durationMs). Integer, non-decreasing, < D,
 * tMs_0 = 0. [] when there are no paragraphs or the duration is not a finite value ≥ 1 ms.
 */
export function estimateMarks(paragraphs: readonly TimedParagraph[], durationMs: number): Mark[] {
  if (paragraphs.length === 0 || !Number.isFinite(durationMs)) return [];
  const D = Math.floor(durationMs);
  if (D <= 0) return [];

  const weights = paragraphs.map((p) => (Number.isFinite(p.words) ? Math.max(0, p.words) : 0) + PAUSE_WORDS);
  const W = weights.reduce((sum, w) => sum + w, 0);

  const marks: Mark[] = [];
  let cumulative = 0;
  let previous = 0;
  for (let i = 0; i < paragraphs.length; i++) {
    // Multiply first (exact expected values); clamp guards float edge cases only.
    const raw = Math.floor((D * cumulative) / W);
    const tMs = Math.min(D - 1, Math.max(previous, raw));
    marks.push({ pid: paragraphs[i].pid, tMs });
    previous = tMs;
    cumulative += weights[i];
  }
  return marks;
}

/**
 * Stored marks win only when they cover the text: the stored marks whose pid is an eligible
 * paragraph are used (`synced`) iff every paragraph has exactly one and the set validates
 * (document order, strictly increasing integers < durationMs). Otherwise the estimate.
 */
export function resolveMarks(
  stored: readonly Mark[],
  paragraphs: readonly TimedParagraph[],
  durationMs: number,
): { marks: Mark[]; timing: ListenTiming } {
  const pids = paragraphs.map((p) => p.pid);
  if (pids.length > 0 && stored.length > 0) {
    const eligible = new Set(pids);
    const kept = stored.filter((m) => eligible.has(m.pid)).map((m) => ({ pid: m.pid, tMs: m.tMs }));
    if (kept.length === pids.length && validateMarks(kept, pids, durationMs).ok) {
      return { marks: kept, timing: 'synced' };
    }
  }
  return { marks: estimateMarks(paragraphs, durationMs), timing: 'estimated' };
}
