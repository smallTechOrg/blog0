import 'server-only';

import { and, desc, eq, isNotNull } from 'drizzle-orm';
import type { Metadata, MetadataRoute } from 'next';

import type { ArticleViewModel } from '@/lib/view-models';

import { getConfig } from '../config';
import { getDb } from '../db/client';
import { article } from '../db/schema';
import { getCurrentSite } from '../site/current';
import type { PublishedArticlePage } from './articles';

// Page metadata for the reader site (design `titleFor`: "<Title> — blog0", home = "blog0";
// spec/capabilities/article-reading.md: meta description = dek; Open Graph for link previews),
// plus the sitemap and robots data (spec/capabilities/reader-site.md "Sitemap/robots").
// Absolute URLs (canonical, og:url, sitemap) come from BLOG0_PUBLIC_BASE_URL.

export const TITLE_SEPARATOR = ' — ';

/** "<name> — <wordmark>" (design BRAND_SUFFIX). */
export function pageTitle(name: string, wordmark: string): string {
  return name + TITLE_SEPARATOR + wordmark;
}

export function articleMetadata(
  a: ArticleViewModel,
  opts: { wordmark: string; mode: 'read' | 'tldr'; publishedAt: Date; updatedAt?: Date | null },
): Metadata {
  const url = opts.mode === 'tldr' && a.deck ? a.deck.shareUrl : a.articleUrl;
  const description = a.dek || undefined;
  return {
    title: pageTitle(a.title, opts.wordmark),
    description,
    // Both addresses show the same article; search engines index the Read address.
    alternates: { canonical: a.articleUrl },
    authors: [{ name: a.bylineName }],
    openGraph: {
      type: 'article',
      title: a.title,
      description,
      url,
      siteName: opts.wordmark,
      publishedTime: opts.publishedAt.toISOString(),
      ...(opts.updatedAt ? { modifiedTime: opts.updatedAt.toISOString() } : {}),
      authors: [a.bylineName],
      section: a.topic || undefined,
    },
    twitter: { card: 'summary', title: a.title, description },
  };
}

/** Metadata for a non-article site page (home, archive, about, not-found). */
export function sitePageMetadata(opts: { title: string; description?: string; url?: string; siteName: string }): Metadata {
  return {
    title: opts.title,
    description: opts.description,
    ...(opts.url ? { alternates: { canonical: opts.url } } : {}),
    openGraph: {
      type: 'website',
      title: opts.title,
      description: opts.description,
      url: opts.url,
      siteName: opts.siteName,
    },
  };
}

/** The public base URL without a trailing slash (BLOG0_PUBLIC_BASE_URL). */
export function publicBase(): string {
  return getConfig().publicBaseUrl.replace(/\/+$/, '');
}

/** The published-only filter (same four conditions as src/server/public/articles.ts). */
function publishedWhere(siteId: string) {
  return and(
    eq(article.siteId, siteId),
    eq(article.status, 'published'),
    isNotNull(article.publishedRevisionId),
    isNotNull(article.firstPublishedAt),
  );
}

/**
 * When a published article last changed for readers: the body-change date when known
 * (Phase 4 `content_updated_at`), else the last publish. Null for an unknown slug.
 */
export async function publishedModifiedAt(slug: string): Promise<Date | null> {
  const site = await getCurrentSite();
  const [row] = await getDb()
    .select({ contentUpdatedAt: article.contentUpdatedAt, lastPublishedAt: article.lastPublishedAt })
    .from(article)
    .where(and(publishedWhere(site.id), eq(article.slug, slug)))
    .limit(1);
  if (!row) return null;
  return row.contentUpdatedAt ?? row.lastPublishedAt ?? null;
}

/** `generateMetadata` for `/p/<slug>` and `/p/<slug>/tldr`; empty for an unknown slug (the page 404s). */
export async function articleRouteMetadata(page: PublishedArticlePage | null, mode: 'read' | 'tldr'): Promise<Metadata> {
  if (!page) return {};
  const modified = page.updatedAt ?? (await publishedModifiedAt(page.article.slug));
  return articleMetadata(page.article, {
    wordmark: page.site.wordmark,
    mode,
    publishedAt: page.publishedAt,
    updatedAt: modified,
  });
}

/** `/sitemap.xml`: the home, archive and about pages plus every published article (Read address). */
export async function sitemapEntries(): Promise<MetadataRoute.Sitemap> {
  const base = publicBase();
  const site = await getCurrentSite();
  const rows = await getDb()
    .select({
      slug: article.slug,
      firstPublishedAt: article.firstPublishedAt,
      lastPublishedAt: article.lastPublishedAt,
      contentUpdatedAt: article.contentUpdatedAt,
    })
    .from(article)
    .where(publishedWhere(site.id))
    .orderBy(desc(article.firstPublishedAt), article.slug);

  const articles: MetadataRoute.Sitemap = rows.map((r) => ({
    url: base + '/p/' + r.slug,
    lastModified: (r.contentUpdatedAt ?? r.lastPublishedAt ?? r.firstPublishedAt) as Date,
    changeFrequency: 'monthly',
    priority: 0.8,
  }));
  const newest = rows.reduce<Date | undefined>((acc, r) => {
    const d = (r.lastPublishedAt ?? r.firstPublishedAt) as Date;
    return !acc || d > acc ? d : acc;
  }, undefined);
  return [
    { url: base + '/', ...(newest ? { lastModified: newest } : {}), changeFrequency: 'weekly', priority: 1 },
    { url: base + '/archive', ...(newest ? { lastModified: newest } : {}), changeFrequency: 'weekly', priority: 0.6 },
    { url: base + '/about', changeFrequency: 'yearly', priority: 0.4 },
    ...articles,
  ];
}

/** `/robots.txt`: everything public is crawlable; the desk and the API are not. */
export function robotsRules(): MetadataRoute.Robots {
  const base = publicBase();
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: ['/admin', '/api/'] }],
    sitemap: base + '/sitemap.xml',
    host: base,
  };
}
