import { describe, expect, it } from 'vitest';

import { buildRssFeed, escapeXml, rfc822, RSS_ITEM_LIMIT, type RssItem } from '@/server/public/rss';

// /feed.xml builder (spec/capabilities/reader-site.md "RSS feed"): pure RSS 2.0 output — escaping,
// newest-first ordering, the 50-item cap, and only items with a first-published date.

const BASE = 'https://blog.example';
const CHANNEL = { title: 'blog0', baseUrl: BASE, description: 'Notes from a small AI startup.' };

function item(slug: string, firstPublishedAt: Date, over: Partial<RssItem> = {}): RssItem {
  return {
    slug,
    title: `Title ${slug}`,
    dek: `Dek ${slug}.`,
    topic: 'Op-Ed',
    bylineName: 'Sai Krishna V',
    articleUrl: `${BASE}/p/${slug}`,
    firstPublishedAt,
    ...over,
  };
}

const day = (n: number) => new Date(Date.UTC(2026, 8, n, 9, 30, 0));

function itemBlocks(xml: string): string[] {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
}

function links(xml: string): string[] {
  return itemBlocks(xml).map((b) => /<link>([^<]*)<\/link>/.exec(b)?.[1] ?? '');
}

describe('escapeXml', () => {
  it('escapes the five XML specials and drops characters XML 1.0 forbids', () => {
    expect(escapeXml(`a & b < c > d "e" 'f'`)).toBe('a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;');
    expect(escapeXml('x\u0000y\u0008z\u000Bw￾v')).toBe('xyzwv');
    expect(escapeXml('tab\tline\nemoji 🙂 é')).toBe('tab\tline\nemoji 🙂 é');
  });

  it('treats already-escaped-looking input as plain text', () => {
    expect(escapeXml('&amp;')).toBe('&amp;amp;');
  });
});

describe('buildRssFeed', () => {
  it('builds an RSS 2.0 channel with title, link, description, atom self link and lastBuildDate', () => {
    const xml = buildRssFeed(CHANNEL, [item('one', day(3), { updatedAt: day(8) }), item('two', day(5))]);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">')).toBe(true);
    const channelHead = xml.slice(0, xml.indexOf('<item>'));
    expect(channelHead).toContain('<title>blog0</title>');
    expect(channelHead).toContain(`<link>${BASE}/</link>`);
    expect(channelHead).toContain('<description>Notes from a small AI startup.</description>');
    expect(channelHead).toContain(`<atom:link href="${BASE}/feed.xml" rel="self" type="application/rss+xml"/>`);
    expect(channelHead).toContain(`<lastBuildDate>${day(8).toUTCString()}</lastBuildDate>`);
    expect(xml.trimEnd().endsWith('</channel>\n</rss>')).toBe(true);
  });

  it('gives each item title, link, permalink guid, RFC 822 pubDate, dek, dc:creator and topic', () => {
    const [block] = itemBlocks(buildRssFeed(CHANNEL, [item('one', day(3))]));
    expect(block).toContain('<title>Title one</title>');
    expect(block).toContain(`<link>${BASE}/p/one</link>`);
    expect(block).toContain(`<guid isPermaLink="true">${BASE}/p/one</guid>`);
    expect(block).toContain('<pubDate>Thu, 03 Sep 2026 09:30:00 GMT</pubDate>');
    expect(block).toContain('<description>Dek one.</description>');
    expect(block).toContain('<dc:creator>Sai Krishna V</dc:creator>');
    expect(block).toContain('<category>Op-Ed</category>');
    expect(block).not.toContain('<author>');
    expect(rfc822(day(3))).toBe('Thu, 03 Sep 2026 09:30:00 GMT');
  });

  it('omits the empty optional fields (dek, topic) and falls back to the title for an empty description', () => {
    const xml = buildRssFeed({ ...CHANNEL, description: '  ' }, [item('bare', day(1), { dek: '', topic: '' })]);
    const [block] = itemBlocks(xml);
    expect(block).not.toContain('<description>');
    expect(block).not.toContain('<category>');
    expect(xml.slice(0, xml.indexOf('<item>'))).toContain('<description>blog0</description>');
  });

  it('escapes every text field (no CDATA, no raw markup)', () => {
    const nasty = item('esc', day(2), {
      title: 'Cats & <dogs> "quoted" \'single\'',
      dek: '</description><script>alert(1)</script>',
      topic: 'R&D',
      bylineName: 'A <b>bold</b> author',
    });
    const xml = buildRssFeed({ title: 'blog & co', baseUrl: BASE, description: '<tag>' }, [nasty]);
    expect(xml).not.toContain('CDATA');
    expect(xml).not.toContain('<script>');
    expect(xml).not.toContain('<b>');
    expect(xml).toContain('<title>Cats &amp; &lt;dogs&gt; &quot;quoted&quot; &apos;single&apos;</title>');
    expect(xml).toContain('<description>&lt;/description&gt;&lt;script&gt;alert(1)&lt;/script&gt;</description>');
    expect(xml).toContain('<category>R&amp;D</category>');
    expect(xml).toContain('<dc:creator>A &lt;b&gt;bold&lt;/b&gt; author</dc:creator>');
    expect(xml).toContain('<title>blog &amp; co</title>');
    expect(xml).toContain('<description>&lt;tag&gt;</description>');
  });

  it('lists items newest first (first publication, then slug)', () => {
    const xml = buildRssFeed(CHANNEL, [item('old', day(1)), item('new', day(9)), item('mid-b', day(5)), item('mid-a', day(5))]);
    expect(links(xml)).toEqual([`${BASE}/p/new`, `${BASE}/p/mid-a`, `${BASE}/p/mid-b`, `${BASE}/p/old`]);
  });

  it(`caps the feed at the ${RSS_ITEM_LIMIT} newest items`, () => {
    const many = Array.from({ length: RSS_ITEM_LIMIT + 7 }, (_, i) => item(`p${String(i).padStart(3, '0')}`, new Date(Date.UTC(2026, 0, 1) + i * 86_400_000)));
    const listed = links(buildRssFeed(CHANNEL, many));
    expect(RSS_ITEM_LIMIT).toBe(50);
    expect(listed).toHaveLength(RSS_ITEM_LIMIT);
    expect(listed[0]).toBe(`${BASE}/p/p056`);
    expect(listed.at(-1)).toBe(`${BASE}/p/p007`);
  });

  it('never lists an item without a valid first-published date (drafts have none) and omits lastBuildDate when empty', () => {
    const draft = item('draft', null as unknown as Date);
    const broken = item('broken', new Date(Number.NaN));
    const xml = buildRssFeed(CHANNEL, [draft, broken]);
    expect(itemBlocks(xml)).toHaveLength(0);
    expect(xml).not.toContain('<lastBuildDate>');
    expect(links(buildRssFeed(CHANNEL, [draft, item('live', day(4))]))).toEqual([`${BASE}/p/live`]);
  });
});
