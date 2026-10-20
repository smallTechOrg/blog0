import { describe, expect, it } from 'vitest';

import { THEME_SCRIPT } from '@/components/site/head-script';

// The pre-paint script (spec/ui.md §1 rule 4): theme, and the typing mark on every load of
// /, /archive and /about (never under reduced motion), with a timeout that hands over anyway.

interface Run {
  attrs: Record<string, string>;
  dataset: Record<string, string>;
  timers: Array<() => void>;
}

function run(opts: { path: string; reduced?: boolean; dark?: boolean; stored?: string }): Run {
  const attrs: Record<string, string> = {};
  const dataset: Record<string, string> = {};
  const timers: Array<() => void> = [];
  const documentElement = {
    dataset,
    setAttribute: (k: string, v: string) => {
      attrs[k] = v;
    },
  };
  const window = {
    location: { pathname: opts.path },
    localStorage: { getItem: () => opts.stored ?? null },
    matchMedia: (q: string) => ({ matches: q.includes('reduced-motion') ? Boolean(opts.reduced) : Boolean(opts.dark) }),
    setTimeout: (fn: () => void) => {
      timers.push(fn);
      return timers.length;
    },
  };
  new Function('window', 'document', THEME_SCRIPT)(window, { documentElement });
  return { attrs, dataset, timers };
}

describe('pre-paint theme + typing script', () => {
  it('every load of /, /archive or /about → data-typing, and a timeout that sets data-typer', () => {
    for (const path of ['/', '/archive', '/about', '/archive/']) {
      const r = run({ path });
      expect(r.dataset.typing, path).toBe('1');
      expect(r.attrs, path).not.toHaveProperty('data-typer');
      expect(r.timers, path).toHaveLength(1);
      r.timers[0]();
      expect(r.attrs['data-typer'], path).toBe('');
    }
  });

  it('other pages and reduced motion → no typing', () => {
    expect(run({ path: '/p/humans-are-software' }).dataset.typing).toBeUndefined();
    expect(run({ path: '/privacy' }).dataset.typing).toBeUndefined();
    for (const path of ['/', '/archive', '/about']) {
      const r = run({ path, reduced: true });
      expect(r.dataset.typing, path).toBeUndefined();
      expect(r.timers, path).toHaveLength(0);
    }
  });

  it('still sets the theme: stored choice wins, else the OS preference', () => {
    expect(run({ path: '/x', stored: 'dark' }).attrs['data-theme']).toBe('dark');
    expect(run({ path: '/x', dark: true }).attrs['data-theme']).toBe('dark');
    expect(run({ path: '/x', dark: true, stored: 'light' }).attrs['data-theme']).toBe('light');
    expect(run({ path: '/x' }).attrs['data-theme']).toBe('light');
  });

  it('never throws out of the script', () => {
    expect(() => new Function('window', 'document', THEME_SCRIPT)(undefined, undefined)).not.toThrow();
  });
});
