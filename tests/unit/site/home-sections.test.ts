import { describe, expect, it } from 'vitest';

import { FEATURED_MAX, splitHomeSections, type HomeRow } from '@/server/public/home';

// Home sections (spec/capabilities/reader-site.md "Business Rules"): Featured = flagged, by rank
// then newest, max 4; Latest = every other published article, newest first.

function row(slug: string, day: number, featured?: { rank: number | null }): HomeRow<string> {
  return {
    card: slug,
    slug,
    firstPublishedAt: new Date(Date.UTC(2026, 8, day)),
    isFeatured: Boolean(featured),
    featuredRank: featured ? featured.rank : null,
  };
}

describe('splitHomeSections', () => {
  it('orders featured by rank and puts every other article in Latest newest first', () => {
    const rows = [
      row('a', 1),
      row('humans', 2, { rank: 3 }),
      row('destroy', 3, { rank: 1 }),
      row('b', 9),
      row('tech', 4, { rank: 2 }),
    ];

    const { featured, latest } = splitHomeSections(rows);

    expect(featured).toEqual(['destroy', 'tech', 'humans']);
    expect(latest).toEqual(['b', 'a']);
  });

  it('breaks rank ties by the newer article and sends unranked featured pieces after the ranked ones', () => {
    const rows = [row('old', 1, { rank: 1 }), row('new', 5, { rank: 1 }), row('unranked', 9, { rank: null })];

    expect(splitHomeSections(rows).featured).toEqual(['new', 'old', 'unranked']);
  });

  it('caps Featured at four and lets the overflow appear in Latest so nothing published is hidden', () => {
    const rows = [1, 2, 3, 4, 5].map((n) => row('f' + n, n, { rank: n }));

    const { featured, latest } = splitHomeSections(rows);

    expect(FEATURED_MAX).toBe(4);
    expect(featured).toEqual(['f1', 'f2', 'f3', 'f4']);
    expect(latest).toEqual(['f5']);
  });

  it('returns two empty sections when nothing is published', () => {
    expect(splitHomeSections([])).toEqual({ featured: [], latest: [] });
  });

  it('keeps Latest stable by slug when two articles share a publish instant', () => {
    const rows = [row('zeta', 4), row('alpha', 4)];

    expect(splitHomeSections(rows).latest).toEqual(['alpha', 'zeta']);
  });
});
