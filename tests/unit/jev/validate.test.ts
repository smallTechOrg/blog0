import { describe, expect, it } from 'vitest';

import { truncateReason, validatePicks } from '@/server/jev/validate';

import { makeSentences, picksJson } from './stub';

const S = makeSentences(10);
const B = { min: 4, max: 6, target: 5 };

describe('validatePicks', () => {
  it('accepts a valid selection and fills sid/text from the server sentences', () => {
    const res = validatePicks(picksJson([0, 3, 6, 9]), S, B);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.picks.map((p) => p.index)).toEqual([0, 3, 6, 9]);
    expect(res.picks[1]).toEqual({ index: 3, sid: S[3].sid, text: S[3].text, reason: 'States the thesis' });
  });

  it('sorts unsorted picks into document order', () => {
    const res = validatePicks(picksJson([9, 2, 5, 0]), S, B);

    expect(res.ok && res.picks.map((p) => p.index)).toEqual([0, 2, 5, 9]);
  });

  it('removes duplicates keeping the first occurrence, without an error', () => {
    const json = JSON.stringify({
      picks: [
        { index: 1, reason: 'first' },
        { index: 4, reason: 'b' },
        { index: 1, reason: 'second' },
        { index: 7, reason: 'c' },
        { index: 8, reason: 'd' },
      ],
    });

    const res = validatePicks(json, S, B);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.picks.map((p) => p.index)).toEqual([1, 4, 7, 8]);
    expect(res.picks[0].reason).toBe('first');
  });

  it('rejects a selection that falls below min after dedupe', () => {
    const res = validatePicks(picksJson([1, 1, 2, 3]), S, B);

    expect(res).toEqual({ ok: false, errors: ['chose 3 distinct sentences; choose between 4 and 6'] });
  });

  it('rejects too few and too many picks with the bounds in the message', () => {
    expect(validatePicks(picksJson([1, 2]), S, B)).toEqual({
      ok: false,
      errors: ['chose 2 distinct sentences; choose between 4 and 6'],
    });
    expect(validatePicks(picksJson([0, 1, 2, 3, 4, 5, 6]), S, B)).toEqual({
      ok: false,
      errors: ['chose 7 distinct sentences; choose between 4 and 6'],
    });
  });

  it('applies count bounds per article length (N < 4 must pick exactly N)', () => {
    const three = makeSentences(3);
    const exact = { min: 3, max: 3, target: 3 };

    expect(validatePicks(picksJson([0, 1, 2]), three, exact).ok).toBe(true);
    expect(validatePicks(picksJson([0, 2]), three, exact)).toEqual({
      ok: false,
      errors: ['chose 2 distinct sentences; choose between 3 and 3'],
    });
  });

  it('rejects out-of-range and negative indices', () => {
    const res = validatePicks(picksJson([0, 3, 10, -1]), S, B);

    expect(res).toEqual({
      ok: false,
      errors: ['picks[2].index 10 is out of range 0..9', 'picks[3].index -1 is out of range 0..9'],
    });
  });

  it('rejects non-integer and missing indices', () => {
    const json = JSON.stringify({
      picks: [{ index: 1.5, reason: 'a' }, { index: '2', reason: 'b' }, { reason: 'c' }, { index: 3, reason: 'd' }],
    });

    const res = validatePicks(json, S, B);

    expect(res).toEqual({
      ok: false,
      errors: [
        'picks[0].index 1.5 is not an integer',
        'picks[1].index "2" is not an integer',
        'picks[2].index missing is not an integer',
      ],
    });
  });

  it('rejects empty and missing reasons', () => {
    const json = JSON.stringify({
      picks: [{ index: 0, reason: '   ' }, { index: 1 }, { index: 2, reason: 'ok' }, { index: 3, reason: 'ok' }],
    });

    const res = validatePicks(json, S, B);

    expect(res).toEqual({
      ok: false,
      errors: ['picks[0].reason is empty; give a one-line reason', 'picks[1].reason is missing; give a one-line reason'],
    });
  });

  it('truncates an over-long reason at a word boundary to at most 200 chars with an ellipsis', () => {
    const long = 'This reason keeps going '.repeat(20);
    const json = JSON.stringify({ picks: [0, 1, 2, 3].map((index) => ({ index, reason: long })) });

    const res = validatePicks(json, S, B);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const reason = res.picks[0].reason;
    expect(reason.length).toBeLessThanOrEqual(200);
    expect(reason.endsWith('…')).toBe(true);
    expect(long.startsWith(reason.slice(0, -1))).toBe(true);
    expect(reason.slice(0, -1)).toMatch(/\w$/);
  });

  it('trims reasons', () => {
    const json = JSON.stringify({ picks: [0, 1, 2, 3].map((index) => ({ index, reason: '  States the thesis \n' })) });

    const res = validatePicks(json, S, B);

    expect(res.ok && res.picks[0].reason).toBe('States the thesis');
  });

  it('rejects malformed JSON and wrong shapes', () => {
    expect(validatePicks('not json {', S, B)).toEqual({ ok: false, errors: ['the output was not valid JSON'] });
    expect(validatePicks('[1,2,3]', S, B)).toEqual({
      ok: false,
      errors: ['the output must be a JSON object {"picks":[{"index":<int>,"reason":"<text>"}]}'],
    });
    expect(validatePicks('{"picks":[1,2,3,4]}', S, B).ok).toBe(false);
  });
});

describe('truncateReason', () => {
  it('keeps short reasons and hard-cuts a single giant word', () => {
    expect(truncateReason('Short.')).toBe('Short.');
    const giant = 'x'.repeat(300);
    const out = truncateReason(giant);
    expect(out.length).toBe(200);
    expect(out.endsWith('…')).toBe(true);
  });
});
