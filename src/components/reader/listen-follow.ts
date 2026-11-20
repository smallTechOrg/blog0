// SMA-36: while the audio plays, the Listen text scrolls slowly along with it. The marks only say
// where each paragraph starts, so inside the live paragraph the reading position is estimated by
// interpolating time between its mark and the next one (or the end of the recording); that line
// eases towards a fixed reading line, frame by frame, instead of the text jumping a whole paragraph
// at a time. Nothing is highlighted from the estimate (owner: not until there is true tracking).
// Pure; unit-tested in tests/unit/reader/listen-follow.test.ts.

import { activeMarkIndex, type Mark } from '@/lib/listen/marks';

/** How quickly the scroll catches up with the reading line (ms to cover ~63 % of the gap). */
export const GLIDE_TAU_MS = 900;

/** Where the line being read sits: this fraction of the visible text area from its top. */
export const READING_LINE = 0.4;

/** The live paragraph's index in `marks` and how far through it the audio is (0–1); null before the first mark. */
export function paragraphProgress(
  marks: readonly Mark[],
  tMs: number,
  durationMs: number,
): { index: number; pid: string; fraction: number } | null {
  const index = activeMarkIndex(marks, tMs);
  if (index === -1) return null;
  const start = marks[index].tMs;
  const next = index + 1 < marks.length ? marks[index + 1].tMs : durationMs;
  const span = next - start;
  const fraction = span > 0 ? (tMs - start) / span : 1;
  return { index, pid: marks[index].pid, fraction: Math.min(1, Math.max(0, fraction)) };
}

/** One frame of the glide: move `current` towards `target`, exponentially, over `dtMs`. */
export function glideStep(current: number, target: number, dtMs: number, tauMs: number = GLIDE_TAU_MS): number {
  if (!(dtMs > 0)) return current;
  const k = 1 - Math.exp(-dtMs / tauMs);
  const next = current + (target - current) * k;
  return Math.abs(target - next) < 0.5 ? target : next;
}

/** The scroll position that puts a line at `lineY` (viewport px) on the reading line between `top` and `bottom`. */
export function scrollTargetFor(scrollY: number, lineY: number, top: number, bottom: number): number {
  const anchor = top + (bottom - top) * READING_LINE;
  return Math.max(0, scrollY + (lineY - anchor));
}
