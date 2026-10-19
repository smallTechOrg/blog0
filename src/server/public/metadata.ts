import 'server-only';

import { desc } from 'drizzle-orm';
import type { Metadata, MetadataRoute } from 'next';

import type { ArticleViewModel } from '@/lib/view-models';

import { getConfig } from '../config';
import { getDb } from '../db/client';
import { article, type SiteRow } from '../db/schema';
import { getCurrentSite } from '../site/current';
import { publishedWhere, type PublishedArticlePage } from './articles';
import { articleJsonLd, homeJsonLd, ogImageMetadata, twitterMetadata } from './seo';

// Page metadata for the reader site (design `titleFor`: "<Title> — blog0", home = "blog0";
// spec/capabilities/article-reading.md: meta description = dek; Open Graph for link previews),
// plus the sitemap and robots data (spec/capabilities/reader-site.md "Sitemap/robots").
// Absolute URLs (canonical, og:url, sitemap) come from BLOG0_PUBLIC_BASE_URL.
// Stage A (spec/ui.md §3 "head and share metadata"): every public page carries the default share
// image and the large Twitter card; `metadataBase` resolves the image path; JSON-LD data per page.

/** `metadataBase` = BLOG0_PUBLIC_BASE_URL (null when it is not a valid URL — then Next's default). */
export function metadataBaseUrl(): URL | null {
  try {
    return new URL(getConfig().publicBaseUrl);
  } catch {
    return null;
  }
}

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
      images: ogImageMetadata(opts.wordmark),
    },
    twitter: twitterMetadata({ title: a.title, description }),
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
      images: ogImageMetadata(opts.siteName),
    },
    twitter: twitterMetadata({ title: opts.title, description: opts.description }),
  };
}

/** The (site) layout's defaults, inherited by public pages that set no share tags of their own
 *  (the newsletter link pages): metadataBase, the share image and the large card. */
export function siteDefaultMetadata(wordmark: string): Metadata {
  const base = metadataBaseUrl();
  return {
    ...(base ? { metadataBase: base } : {}),
    openGraph: { siteName: wordmark, images: ogImageMetadata(wordmark) },
    twitter: twitterMetadata({ title: wordmark }),
  };
}

function sameAsOf(site: Pick<SiteRow, 'socialXUrl' | 'socialLinkedinUrl'>): string[] {
  return [site.socialXUrl, site.socialLinkedinUrl].filter((u): u is string => typeof u === 'string' && u.trim() !== '');
}

/** Home JSON-LD: Organization + WebSite. */
export function homeStructuredData(site: Pick<SiteRow, 'wordmark' | 'socialXUrl' | 'socialLinkedinUrl'>): Record<string, unknown> {
  return homeJsonLd({ brand: site.wordmark, baseUrl: getConfig().publicBaseUrl, sameAs: sameAsOf(site) });
}

/** Article JSON-LD for a loaded published page. */
export function articleStructuredData(page: PublishedArticlePage): Record<string, unknown> {
  return articleJsonLd({
    brand: page.site.wordmark,
    baseUrl: getConfig().publicBaseUrl,
    sameAs: [],
    slug: page.article.slug,
    title: page.article.title,
    dek: page.article.dek,
    authorName: page.article.bylineName,
    firstPublishedAt: page.publishedAt,
    contentUpdatedAt: page.contentUpdatedAt,
  });
}

/** `generateMetadata` for a non-article site page at `path` ('/', '/archive', '/about'): title and
 *  description from the site record, canonical = the absolute address (BLOG0_PUBLIC_BASE_URL). */
export async function sitePageRouteMetadata(
  path: string,
  page: (site: SiteRow) => { title: string; description?: string },
): Promise<Metadata> {
  const site = await getCurrentSite();
  return sitePageMetadata({ ...page(site), url: getConfig().publicBaseUrl + path, siteName: site.wordmark });
}

/** `generateMetadata` for `/p/<slug>` and `/p/<slug>/tldr`; empty for an unknown slug (the page 404s). */
export function articleRouteMetadata(page: PublishedArticlePage | null, mode: 'read' | 'tldr'): Metadata {
  if (!page) return {};
  return articleMetadata(page.article, { wordmark: page.site.wordmark, mode, publishedAt: page.publishedAt, updatedAt: page.updatedAt });
}

/** `/sitemap.xml`: the home, archive and about pages plus every published article (Read address). */
export async function sitemapEntries(): Promise<MetadataRoute.Sitemap> {
  const base = getConfig().publicBaseUrl;
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
    { url: base + '/privacy', changeFrequency: 'yearly', priority: 0.3 },
    ...articles,
  ];
}

/** `/robots.txt`: everything public is crawlable; the desk and the API are not. */
export function robotsRules(): MetadataRoute.Robots {
  const base = getConfig().publicBaseUrl;
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: ['/admin', '/api/'] }],
    sitemap: base + '/sitemap.xml',
    host: base,
  };
}
