import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  TYPE_RUN_MS,
  TYPE_STEP_MAX_MS,
  TYPE_STEP_MIN_MS,
  isTypeRoute,
  setTypingRoute,
  shouldType,
  startTypeRun,
  typeClock,
  typeStep,
  typingActive,
} from '@/components/design/motion';
import { WORDMARK_STEP_MS } from '@/components/design/Wordmark';

// Owner decisions (UI review 2026-10-20, spec/ui.md §1 rule 4 / §3 Chrome): the typewriter runs at
// about half the design's per-character speed, and it runs again whenever the reader arrives on
// /archive or /about (the intro stays the only typing load of /). No boot strip any more.

describe('typing speed', () => {
  it('runs each line over ~1.6 s, with per-character bounds doubled from the design', () => {
    expect(TYPE_RUN_MS).toBe(1600);
    expect(TYPE_STEP_MIN_MS).toBe(14);
    expect(TYPE_STEP_MAX_MS).toBe(52);
    expect(typeStep(0)).toBe(52);
    expect(typeStep(10)).toBe(52); // 160 ms/char, capped at the ceiling
    expect(typeStep(100)).toBe(16); // 1600 / 100
    expect(typeStep(1000)).toBe(14); // floored
  });

  it('types the wordmark at ~110 ms per character', () => {
    expect(WORDMARK_STEP_MS).toBe(110);
  });
});

describe('isTypeRoute', () => {
  it('names /archive and /about (trailing slash ignored) and nothing else', () => {
    expect(isTypeRoute('/archive')).toBe(true);
    expect(isTypeRoute('/about')).toBe(true);
    expect(isTypeRoute('/archive/')).toBe(true);
    expect(isTypeRoute('/')).toBe(false);
    expect(isTypeRoute('')).toBe(false);
    expect(isTypeRoute('/p/humans-are-software')).toBe(false);
    expect(isTypeRoute('/archive/extra')).toBe(false);
    expect(isTypeRoute('/privacy')).toBe(false);
  });
});

describe('setTypingRoute (client route change)', () => {
  const g = globalThis as { document?: unknown };
  let dataset: Record<string, string>;

  beforeEach(() => {
    dataset = {};
    g.document = { documentElement: { dataset } };
  });
  afterEach(() => {
    delete g.document;
  });

  it('marks a typing route and starts a new run (fresh clock origin)', () => {
    const before = typeClock();
    setTypingRoute('/archive');
    expect(dataset.typing).toBe('1');
    expect(typingActive()).toBe(true);
    expect(shouldType()).toBe(true);
    expect(typeClock()).toBeGreaterThanOrEqual(before);
  });

  it('clears the mark on any other route, so the next page renders its typed text complete', () => {
    setTypingRoute('/about');
    expect(dataset.typing).toBe('1');
    setTypingRoute('/p/humans-are-software');
    expect(dataset).not.toHaveProperty('typing');
    expect(shouldType()).toBe(false);
    setTypingRoute('/');
    expect(dataset).not.toHaveProperty('typing');
  });

  it('a new run moves the shared clock forward, never back', () => {
    const t0 = typeClock();
    startTypeRun();
    expect(typeClock()).toBeGreaterThanOrEqual(t0);
  });

  it('is a no-op without a document', () => {
    delete g.document;
    expect(() => setTypingRoute('/archive')).not.toThrow();
    expect(typingActive()).toBe(false);
    expect(shouldType()).toBe(false);
  });
});
