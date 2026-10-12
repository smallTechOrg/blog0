import { describe, expect, it } from 'vitest';

import { parseRange } from '@/server/media/range';

// parseRange(header, size) — spec/architecture.md §9.2 step 5: exactly one of `bytes=a-b`
// (b clamped to size−1), `bytes=a-`, `bytes=-n` (n ≥ 1, clamped to size). Anything else → null
// (ignore the header, serve 200). `a ≥ size` or `n === 0` → 'unsatisfiable' (416).

const SIZE = 1000;

describe('parseRange — satisfiable forms', () => {
  it('bytes=a-b', () => {
    expect(parseRange('bytes=0-1', SIZE)).toEqual({ start: 0, end: 1 });
    expect(parseRange('bytes=10-20', SIZE)).toEqual({ start: 10, end: 20 });
    expect(parseRange('bytes=999-999', SIZE)).toEqual({ start: 999, end: 999 });
  });

  it('bytes=a-b clamps b to size-1', () => {
    expect(parseRange('bytes=500-5000', SIZE)).toEqual({ start: 500, end: 999 });
    expect(parseRange('bytes=0-999999999999', SIZE)).toEqual({ start: 0, end: 999 });
  });

  it('bytes=a- runs to the end', () => {
    expect(parseRange('bytes=0-', SIZE)).toEqual({ start: 0, end: 999 });
    expect(parseRange('bytes=990-', SIZE)).toEqual({ start: 990, end: 999 });
  });

  it('bytes=-n is a suffix, clamped to size', () => {
    expect(parseRange('bytes=-1', SIZE)).toEqual({ start: 999, end: 999 });
    expect(parseRange('bytes=-100', SIZE)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=-5000', SIZE)).toEqual({ start: 0, end: 999 });
  });

  it('tolerates surrounding whitespace and a capitalised unit', () => {
    expect(parseRange('  bytes = 0-1 ', SIZE)).toEqual({ start: 0, end: 1 });
    expect(parseRange('Bytes=0-1', SIZE)).toEqual({ start: 0, end: 1 });
  });

  it('handles a one-byte object', () => {
    expect(parseRange('bytes=0-0', 1)).toEqual({ start: 0, end: 0 });
    expect(parseRange('bytes=-1', 1)).toEqual({ start: 0, end: 0 });
    expect(parseRange('bytes=1-', 1)).toBe('unsatisfiable');
  });
});

describe('parseRange — unsatisfiable (416)', () => {
  it('start at or beyond the size', () => {
    expect(parseRange('bytes=1000-', SIZE)).toBe('unsatisfiable');
    expect(parseRange('bytes=1000-2000', SIZE)).toBe('unsatisfiable');
    expect(parseRange('bytes=1500-', SIZE)).toBe('unsatisfiable');
  });

  it('suffix of zero bytes', () => {
    expect(parseRange('bytes=-0', SIZE)).toBe('unsatisfiable');
  });

  it('anything against an empty object', () => {
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable');
    expect(parseRange('bytes=-1', 0)).toBe('unsatisfiable');
  });
});

describe('parseRange — ignored (null → 200 full)', () => {
  it.each([
    ['null header', null],
    ['empty', ''],
    ['no unit', '0-1'],
    ['other unit', 'items=0-1'],
    ['multiple ranges', 'bytes=0-1,5-6'],
    ['multiple ranges with space', 'bytes=0-1, 5-6'],
    ['start after end', 'bytes=20-10'],
    ['no dash', 'bytes=5'],
    ['bare dash', 'bytes=-'],
    ['missing both', 'bytes='],
    ['negative start', 'bytes=-5-10'],
    ['non-numeric', 'bytes=a-b'],
    ['float', 'bytes=1.5-2'],
    ['hex', 'bytes=0x1-2'],
    ['plus sign', 'bytes=+1-2'],
    ['unsafe integer', 'bytes=99999999999999999999-'],
    ['trailing garbage', 'bytes=0-1x'],
  ])('%s', (_label, header) => {
    expect(parseRange(header, SIZE)).toBeNull();
  });
});
