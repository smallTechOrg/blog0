import { describe, expect, it } from 'vitest';

import { EXCERPT_WORDS, excerptFrom, type ExcerptParagraph } from '@/server/newsletter/issues/excerpt';

// Issue excerpt (capability newsletter-issues.md "Assumed": the first paragraph's first 60 words
// with an ellipsis; an empty body renders the dek only).

const p = (text: string, kind: ExcerptParagraph['kind'] = 'p'): ExcerptParagraph => ({ text, kind });
const words = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `w${i + from}`).join(' ');

describe('excerptFrom', () => {
  it('keeps a short first paragraph whole, without an ellipsis', () => {
    expect(excerptFrom([p('Decks show the strongest lines.'), p('Second paragraph.')])).toBe('Decks show the strongest lines.');
  });

  it('cuts the first paragraph at 60 words and adds an ellipsis', () => {
    const out = excerptFrom([p(words(75)), p('later')]);
    expect(EXCERPT_WORDS).toBe(60);
    expect(out).toBe(`${words(60)}…`);
    expect(out.replace('…', '').split(' ')).toHaveLength(60);
  });

  it('exactly 60 words is not cut', () => {
    expect(excerptFrom([p(words(60))])).toBe(words(60));
  });

  it('drops trailing punctuation before the ellipsis and normalises whitespace', () => {
    const text = `${words(59)} sixtieth,   and more words after`;
    expect(excerptFrom([p(text)])).toBe(`${words(59)} sixtieth…`);
    expect(excerptFrom([p('  spaced\n out   text ')])).toBe('spaced out text');
  });

  it('prefers the first prose paragraph over an opening list item or quote; falls back to any kind', () => {
    expect(excerptFrom([p('a list item', 'li'), p('the prose')])).toBe('the prose');
    expect(excerptFrom([p('only a quote', 'quote')])).toBe('only a quote');
  });

  it('an empty body yields an empty excerpt', () => {
    expect(excerptFrom([])).toBe('');
    expect(excerptFrom([p('   ')])).toBe('');
  });
});
