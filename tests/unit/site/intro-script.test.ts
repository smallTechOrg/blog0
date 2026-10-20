import { describe, expect, it } from 'vitest';

import { INTRO_KEY, THEME_SCRIPT } from '@/components/site/head-script';

// Stage A item 1 (spec/ui.md §1 rule 4): the pre-paint script decides the intro — only the visit's
// first document load, only on `/`, never under reduced motion; storage errors mean "already seen".

interface Run {
  attrs: Record<string, string>;
  dataset: Record<string, string>;
  session: Map<string, string>;
  timers: Array<() => void>;
}

function run(opts: { path: string; seen?: boolean; reduced?: boolean; dark?: boolean; stored?: string; storageThrows?: boolean }): Run {
  const attrs: Record<string, string> = {};
  const dataset: Record<string, string> = {};
  const session = new Map<string, string>(opts.seen ? [[INTRO_KEY, '1']] : []);
  const timers: Array<() => void> = [];
  const documentElement = {
    dataset,
    setAttribute: (k: string, v: string) => {
      attrs[k] = v;
    },
    removeAttribute: (k: string) => {
      delete attrs[k];
    },
  };
  const blocked = () => {
    throw new Error('SecurityError');
  };
  const window = {
    location: { pathname: opts.path },
    localStorage: { getItem: () => opts.stored ?? null },
    sessionStorage: opts.storageThrows
      ? { getItem: blocked, setItem: blocked }
      : { getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => void session.set(k, v) },
    matchMedia: (q: string) => ({ matches: q.includes('reduced-motion') ? Boolean(opts.reduced) : Boolean(opts.dark) }),
    setTimeout: (fn: () => void) => {
      timers.push(fn);
      return timers.length;
    },
  };
  // The script reads globals the way a browser exposes them.
  new Function('window', 'document', THEME_SCRIPT)(window, { documentElement });
  return { attrs, dataset, session, timers };
}

describe('pre-paint theme + intro script', () => {
  it('first load of / → intro: data-intro=1 and data-printing (lifted by a timeout), visit marked', () => {
    const r = run({ path: '/' });
    expect(r.dataset.intro).toBe('1');
    expect(r.dataset.typing).toBe('1');
    expect(r.attrs['data-printing']).toBe('');
    expect(r.session.get(INTRO_KEY)).toBe('1');
    expect(r.timers).toHaveLength(1);
    r.timers[0]();
    expect(r.attrs).not.toHaveProperty('data-printing');
  });

  it('a later load of / in the same visit → no intro, no hold, but the typewriter still types', () => {
    const r = run({ path: '/', seen: true });
    expect(r.dataset.intro).toBeUndefined();
    expect(r.dataset.typing).toBe('1');
    expect(r.attrs).not.toHaveProperty('data-printing');
    expect(r.timers).toHaveLength(0);
  });

  it('any load of /, /archive or /about → typing (no hold unless it is the visit\'s first load of /)', () => {
    for (const path of ['/archive', '/about', '/archive/']) {
      const r = run({ path, seen: true });
      expect(r.dataset.typing, path).toBe('1');
      expect(r.dataset.intro, path).toBeUndefined();
      expect(r.attrs, path).not.toHaveProperty('data-printing');
      expect(r.timers, path).toHaveLength(0);
    }
  });

  it('reduced motion → /, /archive and /about never type', () => {
    expect(run({ path: '/', reduced: true }).dataset.typing).toBeUndefined();
    expect(run({ path: '/archive', reduced: true }).dataset.typing).toBeUndefined();
    expect(run({ path: '/about', reduced: true }).dataset.typing).toBeUndefined();
  });

  it('a visit that starts on an article → no intro, but the visit is marked (going home later shows no intro)', () => {
    const r = run({ path: '/p/humans-are-software' });
    expect(r.dataset.intro).toBeUndefined();
    expect(r.dataset.typing).toBeUndefined();
    expect(r.attrs).not.toHaveProperty('data-printing');
    expect(r.session.get(INTRO_KEY)).toBe('1');
  });

  it('reduced motion → no intro even on the first load of /', () => {
    const r = run({ path: '/', reduced: true });
    expect(r.dataset.intro).toBeUndefined();
    expect(r.dataset.typing).toBeUndefined();
    expect(r.attrs).not.toHaveProperty('data-printing');
  });

  it('blocked storage → treated as already seen', () => {
    const r = run({ path: '/', storageThrows: true });
    expect(r.dataset.intro).toBeUndefined();
    expect(r.attrs).not.toHaveProperty('data-printing');
    expect(r.attrs['data-theme']).toBe('light');
  });

  it('still sets the theme: stored choice wins, else the OS preference', () => {
    expect(run({ path: '/x', stored: 'dark' }).attrs['data-theme']).toBe('dark');
    expect(run({ path: '/x', dark: true }).attrs['data-theme']).toBe('dark');
    expect(run({ path: '/x', dark: true, stored: 'light' }).attrs['data-theme']).toBe('light');
  });

  it('never throws out of the script', () => {
    expect(() => new Function('window', 'document', THEME_SCRIPT)(undefined, undefined)).not.toThrow();
  });
});
