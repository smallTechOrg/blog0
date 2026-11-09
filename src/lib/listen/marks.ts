// Listen marks helpers (spec/architecture.md §9.4). Pure + isomorphic: the server validates
// aligner-facing mark saves with them, the reader highlight finds the live paragraph with them,
// the players format clocks and minutes with them. Rules: spec/capabilities/listen-sync.md.

export interface Mark {
  pid: string;
  tMs: number;
}

export type MarkIssueCode = 'UNKNOWN_PID' | 'MISSING_PID' | 'DUPLICATE_PID' | 'OUT_OF_ORDER' | 'NOT_INCREASING' | 'OUT_OF_RANGE';
export type MarkIssue = { code: MarkIssueCode; pid?: string; index?: number };

/** ←/→ seek step (seconds) in the reader's player. */
export const SEEK_STEP_S = 5;

function isValidTime(tMs: number, durationMs: number): boolean {
  return Number.isInteger(tMs) && tMs >= 0 && tMs < durationMs;
}

/**
 * A mark set is valid when it holds exactly one mark per paragraph, in document order, with
 * strictly increasing integer times in [0, durationMs). Every violation is listed, with the
 * mark's index where one applies (MISSING_PID names the paragraph only).
 */
export function validateMarks(
  marks: readonly Mark[],
  paragraphPids: readonly string[],
  durationMs: number,
): { ok: true } | { ok: false; reasons: MarkIssue[] } {
  const reasons: MarkIssue[] = [];
  const position = new Map<string, number>();
  paragraphPids.forEach((pid, i) => {
    if (!position.has(pid)) position.set(pid, i);
  });

  const seen = new Set<string>();
  let lastPosition = -1;
  let lastTime: number | null = null;
  marks.forEach((mark, index) => {
    const pos = position.get(mark.pid);
    if (pos === undefined) {
      reasons.push({ code: 'UNKNOWN_PID', pid: mark.pid, index });
    } else if (seen.has(mark.pid)) {
      reasons.push({ code: 'DUPLICATE_PID', pid: mark.pid, index });
    } else {
      seen.add(mark.pid);
      if (pos < lastPosition) reasons.push({ code: 'OUT_OF_ORDER', pid: mark.pid, index });
      lastPosition = Math.max(lastPosition, pos);
    }
    if (!isValidTime(mark.tMs, durationMs)) {
      reasons.push({ code: 'OUT_OF_RANGE', pid: mark.pid, index });
    } else {
      if (lastTime !== null && mark.tMs <= lastTime) reasons.push({ code: 'NOT_INCREASING', pid: mark.pid, index });
      lastTime = mark.tMs;
    }
  });

  for (const pid of paragraphPids) {
    if (!seen.has(pid)) reasons.push({ code: 'MISSING_PID', pid });
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

/** Index of the mark with the greatest tMs ≤ tMs; −1 before the first mark. Binary search. */
export function activeMarkIndex(marks: readonly Mark[], tMs: number): number {
  let lo = 0;
  let hi = marks.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (marks[mid].tMs <= tMs) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** max(1, round(durationMs / 60000)) — the design's `audioMinutes`. */
export function listenMinutes(durationMs: number): number {
  return Math.max(1, Math.round((Number.isFinite(durationMs) ? durationMs : 0) / 60_000));
}

/** "m:ss" — the design's `fmtClock`, over milliseconds. */
export function fmtClock(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const totalSec = Math.floor(safe / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}
