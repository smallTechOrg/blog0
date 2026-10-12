import 'server-only';

import type { Metadata } from 'next';

import type { ArticleViewModel } from '@/lib/view-models';

// Page metadata for the reader site (design `titleFor`: "<Title> — log0", home = "log0";
// spec/capabilities/article-reading.md: meta description = dek; Open Graph for link previews).

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
