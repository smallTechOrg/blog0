import { describe, expect, it } from 'vitest';

import type { JevBatch } from '@/server/jev/state';
import { invalidOutputMessage, validateAnswers } from '@/server/jev/validate';

const batch = (...sids: string[]): JevBatch => ({ questions: sids.map((sid, index) => ({ sid, index })), requestChars: 0 });
const noul = (n: unknown) => ({ type: 'noul', noul: n });

describe('validateAnswers', () => {
  it('returns every score by sid across batches', () => {
    const v = validateAnswers([batch('a', 'b'), batch('c')], [{ a: noul(0.1), b: noul(1) }, { c: noul(0) }]);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect([...v.scoresBySid]).toEqual([
      ['a', 0.1],
      ['b', 1],
      ['c', 0],
    ]);
    expect(v.extra).toBe(0);
  });

  it('ignores (and counts) ids we did not ask', () => {
    const v = validateAnswers([batch('a')], [{ a: noul(0.4), zz: noul(0.9), other: 'x' }]);
    expect(v).toMatchObject({ ok: true, extra: 2 });
  });

  it('an answer for a sid asked in ANOTHER batch does not count for this batch', () => {
    const v = validateAnswers([batch('a'), batch('b')], [{ a: noul(0.4), b: noul(0.5) }, {}]);
    expect(v).toEqual({ ok: false, missing: ['b'], invalid: [], extra: 1 });
  });

  it.each([
    ['above 1', noul(1.2)],
    ['below 0', noul(-0.1)],
    ['NaN', noul(Number.NaN)],
    ['Infinity', noul(Number.POSITIVE_INFINITY)],
    ['a string', noul('0.5')],
    ['wrong type', { type: 'bool', noul: 0.5 }],
    ['no noul', { type: 'noul' }],
    ['null', null],
    ['a bare number', 0.5],
  ])('marks %s as invalid', (_label, answer) => {
    const v = validateAnswers([batch('a', 'b')], [{ a: noul(0.3), b: answer }]);
    expect(v).toEqual({ ok: false, missing: [], invalid: ['b'], extra: 0 });
  });

  it('reports missing ids and a missing batch', () => {
    const v = validateAnswers([batch('a', 'b'), batch('c')], [{ a: noul(0.3) }]);
    expect(v).toEqual({ ok: false, missing: ['b', 'c'], invalid: [], extra: 0 });
  });

  it('accepts the [0,1] bounds exactly', () => {
    expect(validateAnswers([batch('a', 'b')], [{ a: noul(0), b: noul(1) }]).ok).toBe(true);
  });

  it('writer message carries the count', () => {
    expect(invalidOutputMessage(2, 31)).toBe("Jev didn't score every sentence (2 of 31 missing or invalid) — try again, or pick lines yourself.");
  });
});
