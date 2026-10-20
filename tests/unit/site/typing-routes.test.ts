import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isTypeRoute, setTypingRoute, shouldType, typingActive } from '@/components/design/motion';
import { TYPE_CHAR_MS, cursorAt, weight } from '@/components/design/page-typer';

// Owner decisions (UI review 2026-10-20, spec/ui.md §1 rule 4): Home, /archive and /about type the
// whole page in on every arrival, in reading order, at one constant speed.

describe('page typewriter', () => {
  it('types every character at the same constant speed', () => {
    expect(TYPE_CHAR_MS).toBe(10);
  });

  it('whitespace costs no time', () => {
    expect(weight(' a b\n c ')).toBe(3);
    expect(weight('   ')).toBe(0);
  });

  it('finds where the untyped tail starts, strictly in order across texts', () => {
    const texts = ['blog0', 'a tagline', ' ', 'Archive'];
    expect(cursorAt(texts, 0)).toEqual({ index: 0, offset: 0 });
    expect(cursorAt(texts, 4)).toEqual({ index: 0, offset: 4 });
    expect(cursorAt(texts, 5)).toEqual({ index: 1, offset: 0 });
    expect(cursorAt(texts, 6)).toEqual({ index: 1, offset: 2 }); // skips the space
    expect(cursorAt(texts, 13)).toEqual({ index: 3, offset: 0 }); // skips the blank text
    expect(cursorAt(texts, 19)).toEqual({ index: 3, offset: 6 });
    expect(cursorAt(texts, 20)).toBeNull();
    expect(cursorAt([], 0)).toBeNull();
  });
});

describe('isTypeRoute', () => {
  it('names /, /archive and /about (trailing slash ignored) and nothing else', () => {
    expect(isTypeRoute('/')).toBe(true);
    expect(isTypeRoute('')).toBe(true);
    expect(isTypeRoute('/archive')).toBe(true);
    expect(isTypeRoute('/about')).toBe(true);
    expect(isTypeRoute('/archive/')).toBe(true);
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

  it('marks a typing route and clears the mark elsewhere', () => {
    setTypingRoute('/archive');
    expect(dataset.typing).toBe('1');
    expect(typingActive()).toBe(true);
    expect(shouldType()).toBe(true);
    setTypingRoute('/p/humans-are-software');
    expect(dataset).not.toHaveProperty('typing');
    expect(shouldType()).toBe(false);
    setTypingRoute('/');
    expect(dataset.typing).toBe('1');
  });

  it('is a no-op without a document', () => {
    delete g.document;
    expect(() => setTypingRoute('/archive')).not.toThrow();
    expect(typingActive()).toBe(false);
  });
});
