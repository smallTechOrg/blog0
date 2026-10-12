// Listen marks helpers (spec/architecture.md §9.4). Pure + isomorphic: the server validates
// saves and computes the stale diff with them, the admin tap-sync nudges/undoes with them, the
// reader highlight finds the live paragraph with them. Rules: spec/capabilities/listen-sync.md.

export interface Mark {
  pid: string;
  tMs: number;
}

export type MarkIssueCode = 'UNKNOWN_PID' | 'MISSING_PID' | 'DUPLICATE_PID' | 'OUT_OF_ORDER' | 'NOT_INCREASING' | 'OUT_OF_RANGE';
export type MarkIssue = { code: MarkIssueCode; pid?: string; index?: number };

/** One nudge step (ms). */
export const NUDGE_MS = 250;
/** Taps closer than this are ignored during syncing. */
export const TAP_DEBOUNCE_MS = 300;
/** ←/→ seek step (seconds) in the reader's player. */
export const SEEK_STEP_S = 5;
/** Auto-scroll pauses this long after a manual scroll. */
export const AUTOSCROLL_PAUSE_MS = 4000;

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

/** A copy with mark `index` moved by ±250 ms, or null when ordering or the bounds would break. */
export function nudgeMark(marks: readonly Mark[], index: number, deltaMs: 250 | -250, durationMs: number): Mark[] | null {
  if (!Number.isInteger(index) || index < 0 || index >= marks.length) return null;
  const next = marks[index].tMs + deltaMs;
  if (!isValidTime(next, durationMs)) return null;
  if (index > 0 && next <= marks[index - 1].tMs) return null;
  if (index < marks.length - 1 && next >= marks[index + 1].tMs) return null;
  return marks.map((m, i) => (i === index ? { pid: m.pid, tMs: next } : { pid: m.pid, tMs: m.tMs }));
}

/** Paragraphs without a mark (document order) and marks whose paragraph vanished (mark order). */
export function listenDiff(marks: readonly Mark[], paragraphPids: readonly string[]): { missingPids: string[]; orphanPids: string[] } {
  const marked = new Set(marks.map((m) => m.pid));
  const present = new Set(paragraphPids);
  return {
    missingPids: paragraphPids.filter((pid) => !marked.has(pid)),
    orphanPids: marks.filter((m) => !present.has(m.pid)).map((m) => m.pid),
  };
}

/** max(1, round(durationMs / 60000)) — the design's `audioMinutes`. */
export function listenMinutes(durationMs: number): number {
  return Math.max(1, Math.round((Number.isFinite(durationMs) ? durationMs : 0) / 60_000));
}

function clockParts(ms: number): { m: number; s: number; rest: number } {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const totalSec = Math.floor(safe / 1000);
  return { m: Math.floor(totalSec / 60), s: totalSec % 60, rest: Math.floor(safe % 1000) };
}

/** "m:ss" — the design's `fmtClock`, over milliseconds. */
export function fmtClock(ms: number): string {
  const { m, s } = clockParts(ms);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

/** "m:ss.mmm" for the admin mark list. */
export function fmtClockMs(ms: number): string {
  const { rest } = clockParts(ms);
  return `${fmtClock(ms)}.${String(rest).padStart(3, '0')}`;
}
