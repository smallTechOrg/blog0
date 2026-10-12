import type { ByteRange } from '../storage/types';

// parseRange(header, size) — pure (spec/architecture.md §9.2 step 5). Exactly one of
// `bytes=a-b` (b clamped to size−1), `bytes=a-`, `bytes=-n` (n ≥ 1, clamped to size).
// Anything else (multiple ranges, non-`bytes` unit, malformed) → null = ignore the header (200).
// `a ≥ size` or `n === 0` (or an empty object) → 'unsatisfiable' (416, `Content-Range: bytes */size`).

export type RangeResult = ByteRange | null | 'unsatisfiable';

const RANGE_RE = /^bytes\s*=\s*(\d*)\s*-\s*(\d*)$/i;

function toInt(digits: string): number | null {
  if (digits === '') return null;
  const n = Number(digits);
  return Number.isSafeInteger(n) ? n : NaN;
}

export function parseRange(header: string | null | undefined, size: number): RangeResult {
  if (!header) return null;
  const m = RANGE_RE.exec(header.trim());
  if (!m) return null;
  const a = toInt(m[1]);
  const b = toInt(m[2]);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  if (a === null && b === null) return null;

  if (a === null) {
    // suffix: bytes=-n
    const n = b as number;
    if (n === 0 || size === 0) return 'unsatisfiable';
    const start = Math.max(0, size - n);
    return { start, end: size - 1 };
  }

  if (b !== null && b < a) return null;
  if (a >= size) return 'unsatisfiable';
  const end = b === null ? size - 1 : Math.min(b, size - 1);
  return { start: a, end };
}
