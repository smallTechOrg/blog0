import { describe, expect, it } from 'vitest';

import { botDropReason, MIN_FILL_MS } from '@/server/newsletter/bot-check';
import { subscribeBody } from '@/server/newsletter/schemas';

// Stage A bot drop (spec/api.md POST /api/newsletter; newsletter-list.md): a filled honeypot or a
// submission under 2 s (or without the fill time) is dropped silently, after validation.

const parse = (body: unknown) => subscribeBody.parse(body);

describe('botDropReason', () => {
  it('a human: empty honeypot and ≥ 2 000 ms → null', () => {
    expect(MIN_FILL_MS).toBe(2000);
    expect(botDropReason(parse({ email: 'a@b.io', website: '', fillMs: 2000 }))).toBeNull();
    expect(botDropReason(parse({ email: 'a@b.io', fillMs: 86_400_000 }))).toBeNull();
    expect(botDropReason(parse({ email: 'a@b.io', website: '   ', fillMs: 5000 }))).toBeNull();
  });

  it('a filled honeypot → honeypot (wins over the fill time)', () => {
    expect(botDropReason(parse({ email: 'a@b.io', website: 'x', fillMs: 5000 }))).toBe('honeypot');
    expect(botDropReason(parse({ email: 'a@b.io', website: 'https://spam.example', fillMs: 10 }))).toBe('honeypot');
  });

  it('missing or < 2 000 ms → too_fast', () => {
    expect(botDropReason(parse({ email: 'a@b.io' }))).toBe('too_fast');
    expect(botDropReason(parse({ email: 'a@b.io', fillMs: 1999 }))).toBe('too_fast');
    expect(botDropReason(parse({ email: 'a@b.io', fillMs: 0 }))).toBe('too_fast');
  });
});

describe('subscribeBody — Stage A fields', () => {
  it('accepts website (≤ 200) and an integer fillMs 0–86 400 000', () => {
    expect(parse({ email: 'a@b.io', website: 'w'.repeat(200), fillMs: 0 })).toMatchObject({ website: 'w'.repeat(200), fillMs: 0 });
  });

  it('wrong types or out-of-range values are a validation failure (400)', () => {
    for (const bad of [
      { email: 'a@b.io', fillMs: 'x' },
      { email: 'a@b.io', fillMs: 1.5 },
      { email: 'a@b.io', fillMs: -1 },
      { email: 'a@b.io', fillMs: 86_400_001 },
      { email: 'a@b.io', website: 5 },
      { email: 'a@b.io', website: 'w'.repeat(201) },
    ]) {
      expect(subscribeBody.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
