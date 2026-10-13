import { describe, expect, it } from 'vitest';

import {
  archiveHref,
  archiveSummary,
  archiveTopics,
  filterArchive,
  groupByMonth,
  rowDate,
  topicFromQuery,
} from '@/components/site/archive/archive-model';
import type { PostCardViewModel } from '@/lib/view-models';

// The design's Archive (spec/design/design-app.js `Archive`): newest first, grouped by month of
// first publication, pills for the topics published articles carry, "N articles[ in T], newest first."

function post(slug: string, topic: string, publishedLabel: string): PostCardViewModel {
  return { slug, title: slug.toUpperCase(), dek: '', topic, publishedLabel, inProgress: false, times: { tldr: null, listen: null } };
}

// Server order: newest first.
const POSTS = [
  post('e', 'Op-Ed', '28 Sep 2026'),
  post('d', 'Engineering', '8 Sep 2026'),
  post('c', 'Op-Ed', '30 Aug 2026'),
  post('b', 'Business', '2 Aug 2026'),
  post('a', 'Engineering', '15 Dec 2025'),
];

describe('archive model', () => {
  it('groups newest first by month with the design month headings', () => {
    const groups = groupByMonth(POSTS);

    expect(groups.map((g) => g.heading)).toEqual(['September 2026', 'August 2026', 'December 2025']);
    expect(groups.map((g) => g.items.map((p) => p.slug))).toEqual([['e', 'd'], ['c', 'b'], ['a']]);
  });

  it('prints the row date as day + month (design: fmtDate(...).split(" ").slice(0, 2))', () => {
    expect(rowDate('8 Sep 2026')).toBe('8 Sep');
  });

  it('offers only the topics published articles carry, newest topic first, once each', () => {
    expect(archiveTopics(POSTS)).toEqual(['Op-Ed', 'Engineering', 'Business']);
    expect(archiveTopics([])).toEqual([]);
  });

  it('filters by exact topic and writes the header line the design way', () => {
    const opEd = filterArchive(POSTS, 'Op-Ed');

    expect(opEd.map((p) => p.slug)).toEqual(['e', 'c']);
    expect(filterArchive(POSTS, null)).toHaveLength(5);
    expect(archiveSummary(5, null)).toBe('5 articles, newest first.');
    expect(archiveSummary(2, 'Op-Ed')).toBe('2 articles in Op-Ed, newest first.');
    expect(archiveSummary(1, 'Business')).toBe('1 article in Business, newest first.');
  });

  it('treats an unknown topic as a filter with nothing behind it', () => {
    const none = filterArchive(POSTS, 'Poetry');

    expect(none).toEqual([]);
    expect(groupByMonth(none)).toEqual([]);
    expect(archiveSummary(0, 'Poetry')).toBe('0 articles in Poetry, newest first.');
  });

  it('reads ?topic= safely: blank, repeated and over-long values', () => {
    expect(topicFromQuery(undefined)).toBeNull();
    expect(topicFromQuery('   ')).toBeNull();
    expect(topicFromQuery(' Op-Ed ')).toBe('Op-Ed');
    expect(topicFromQuery(['Business', 'Op-Ed'])).toBe('Business');
    expect(topicFromQuery('x'.repeat(200))).toBeNull();
  });

  it('builds the archive address for a topic (footer topics land pre-filtered)', () => {
    expect(archiveHref(null)).toBe('/archive');
    expect(archiveHref('Op-Ed')).toBe('/archive?topic=Op-Ed');
    expect(archiveHref('AI & Society')).toBe('/archive?topic=AI%20%26%20Society');
  });

  it('keeps undated rows (unparseable label) in a last "Undated" group instead of crashing', () => {
    const groups = groupByMonth([post('x', 'Op-Ed', ''), ...POSTS.slice(0, 1)]);

    expect(groups.map((g) => g.heading)).toEqual(['September 2026', 'Undated']);
  });
});
