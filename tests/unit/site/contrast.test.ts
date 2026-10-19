import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// Stage A item 3 (spec/ui.md §5, §6): the effective `--faint` of each of the three theme blocks
// (design.css, then the additions.css override loaded after it) reaches WCAG 4.5:1 against both
// `--bg` and `--surface` of that theme.

const STYLES = path.join(process.cwd(), 'src', 'styles');
const DESIGN = readFileSync(path.join(STYLES, 'design.css'), 'utf8');
const ADDITIONS = readFileSync(path.join(STYLES, 'additions.css'), 'utf8');

const THEMES = {
  light: ':root',
  dark: ':root[data-theme="dark"]',
  'dark (OS preference)': ':root:not([data-theme="light"])',
} as const;

/** Custom properties declared directly in blocks whose selector is exactly `selector` (later wins). */
function customProps(css: string, selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(noComments); m; m = re.exec(noComments)) {
    const sel = m[1].trim().replace(/^@media[^{]*\{\s*/, '').trim();
    if (sel !== selector) continue;
    for (const decl of m[2].split(';')) {
      const d = /^\s*(--[\w-]+)\s*:\s*(.+?)\s*$/.exec(decl);
      if (d) out[d[1]] = d[2];
    }
  }
  return out;
}

function effective(selector: string): Record<string, string> {
  return { ...customProps(DESIGN, selector), ...customProps(ADDITIONS, selector) };
}

function rgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) as [number, number, number];
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('--faint contrast (WCAG AA, 4.5:1)', () => {
  it('computes the known WCAG ratios', () => {
    expect(contrast('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrast('#777777', '#FFFFFF')).toBeCloseTo(4.48, 2);
  });

  it('the design value alone fails, so the override is load-bearing', () => {
    const light = customProps(DESIGN, ':root');
    expect(contrast(light['--faint'], light['--bg'])).toBeLessThan(4.5);
  });

  for (const [name, selector] of Object.entries(THEMES)) {
    it(`${name}: --faint ≥ 4.5:1 against --bg and --surface`, () => {
      const vars = effective(selector);
      expect(vars['--faint'], `${selector} --faint`).toMatch(/^#[0-9a-f]{6}$/i);
      expect(contrast(vars['--faint'], vars['--bg'])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(vars['--faint'], vars['--surface'])).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('overrides in additions.css only — design.css keeps the design values verbatim', () => {
    expect(customProps(DESIGN, ':root')['--faint']).toBe('#8C8F95');
    expect(customProps(DESIGN, ':root[data-theme="dark"]')['--faint']).toBe('#857F75');
    for (const selector of Object.values(THEMES)) expect(customProps(ADDITIONS, selector)['--faint']).toBeDefined();
  });
});
