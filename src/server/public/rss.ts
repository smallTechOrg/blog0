// RSS 2.0 feed builder for /feed.xml (spec/capabilities/reader-site.md "RSS feed"). Pure: no
// config, no DB — the caller (rssFeed() in metadata.ts) passes the absolute base URL, the site
// values and the published articles. Every text value is XML-escaped; no CDATA.

import type { ArticleViewModel } from '@/lib/view-models';

/** The feed lists at most this many articles (the newest). */
export const RSS_ITEM_LIMIT = 50;

export const RSS_CONTENT_TYPE = 'application/rss+xml; charset=utf-8';

export interface RssChannel {
  /** Site wordmark. */
  title: string;
  /** BLOG0_PUBLIC_BASE_URL (no trailing slash). */
  baseUrl: string;
  /** Site description (the tagline); the title is used when empty. */
  description: string;
}

/** One published article: the article view-model fields the feed needs plus its dates. */
export type RssItem = Pick<ArticleViewModel, 'title' | 'dek' | 'topic' | 'bylineName' | 'articleUrl'> & {
  slug: string;
  firstPublishedAt: Date;
  /** Newest of last_published_at / content_updated_at (null when never republished or edited). */
  updatedAt?: Date | null;
};

// XML 1.0 Char: #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF].
const NOT_XML_CHAR = /[^\x09\x0A\x0D\x20-퟿-�\u{10000}-\u{10FFFF}]/gu;

/** Escapes text for an XML element or attribute value and drops characters XML 1.0 forbids. */
export function escapeXml(text: string): string {
  return text
    .replace(NOT_XML_CHAR, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** RFC 822 date (RSS 2.0 `pubDate` / `lastBuildDate`), always GMT. */
export function rfc822(d: Date): string {
  return d.toUTCString();
}

function el(name: string, text: string): string {
  return `<${name}>${escapeXml(text)}</${name}>`;
}

/** Newest first by first publication, then slug (the sitemap's order). */
function newestFirst(a: RssItem, b: RssItem): number {
  return b.firstPublishedAt.getTime() - a.firstPublishedAt.getTime() || a.slug.localeCompare(b.slug);
}

function itemXml(item: RssItem): string {
  const lines = [
    el('title', item.title),
    el('link', item.articleUrl),
    `<guid isPermaLink="true">${escapeXml(item.articleUrl)}</guid>`,
    el('pubDate', rfc822(item.firstPublishedAt)),
  ];
  if (item.dek.trim() !== '') lines.push(el('description', item.dek));
  if (item.bylineName.trim() !== '') lines.push(el('dc:creator', item.bylineName));
  if (item.topic.trim() !== '') lines.push(el('category', item.topic));
  return `    <item>\n${lines.map((l) => '      ' + l).join('\n')}\n    </item>`;
}

/**
 * The RSS 2.0 document: newest `RSS_ITEM_LIMIT` items first; `lastBuildDate` = the newest change
 * among the listed items (omitted when there are none). Items without a valid first-published
 * date are never listed (only published articles have one).
 */
export function buildRssFeed(channel: RssChannel, items: readonly RssItem[]): string {
  const listed = items
    .filter((i) => i.firstPublishedAt instanceof Date && !Number.isNaN(i.firstPublishedAt.getTime()))
    .slice()
    .sort(newestFirst)
    .slice(0, RSS_ITEM_LIMIT);
  const lastBuild = listed.reduce<Date | null>((acc, i) => {
    const d = i.updatedAt && i.updatedAt > i.firstPublishedAt ? i.updatedAt : i.firstPublishedAt;
    return !acc || d > acc ? d : acc;
  }, null);
  const description = channel.description.trim() !== '' ? channel.description : channel.title;
  const head = [
    el('title', channel.title),
    el('link', channel.baseUrl + '/'),
    el('description', description),
    el('language', 'en'),
    `<atom:link href="${escapeXml(channel.baseUrl + '/feed.xml')}" rel="self" type="application/rss+xml"/>`,
    ...(lastBuild ? [el('lastBuildDate', rfc822(lastBuild))] : []),
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">',
    '  <channel>',
    ...head.map((l) => '    ' + l),
    ...listed.map(itemXml),
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
}
