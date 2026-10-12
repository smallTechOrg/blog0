import { describe, expect, it } from 'vitest';

import { legacyHashTarget } from '@/components/site/LegacyHashRedirect';

// Legacy design hash links → real routes (spec/architecture.md divergence 1).

describe('legacyHashTarget', () => {
  it('maps article, deck, archive and about hashes to their real routes', () => {
    expect(legacyHashTarget('#tech-company-first')).toBe('/p/tech-company-first');
    expect(legacyHashTarget('#tech-company-first/tldr')).toBe('/p/tech-company-first/tldr');
    expect(legacyHashTarget('#archive')).toBe('/archive');
    expect(legacyHashTarget('#about')).toBe('/about');
    expect(legacyHashTarget('humans-are-software')).toBe('/p/humans-are-software');
  });

  it('maps a design sentence or paragraph highlight to its article', () => {
    expect(legacyHashTarget('#hl=humans-are-software-p3-s1')).toBe('/p/humans-are-software');
    expect(legacyHashTarget('#hl=ai-is-expensive-p12')).toBe('/p/ai-is-expensive');
    expect(legacyHashTarget('#hl=top-p2-thing-p4-s0')).toBe('/p/top-p2-thing');
  });

  it('leaves empty hashes, in-page anchors and the home hash alone', () => {
    expect(legacyHashTarget('')).toBeNull();
    expect(legacyHashTarget('#')).toBeNull();
    expect(legacyHashTarget('#home')).toBeNull();
    expect(legacyHashTarget('#newsletter')).toBeNull();
    expect(legacyHashTarget('#topics')).toBeNull();
  });

  it('rejects malformed hashes instead of building a bad path', () => {
    expect(legacyHashTarget('#Bad Slug')).toBeNull();
    expect(legacyHashTarget('#../admin')).toBeNull();
    expect(legacyHashTarget('#a//tldr')).toBeNull();
    expect(legacyHashTarget('#x/tldr/extra')).toBeNull();
    expect(legacyHashTarget('#hl=')).toBeNull();
    expect(legacyHashTarget('#hl=no-sentence-id')).toBeNull();
    expect(legacyHashTarget('#%E0%A4%A')).toBeNull();
  });
});
