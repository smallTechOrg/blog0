// Share metadata + structured data for the reader site (Stage A — spec/ui.md §3 "head and share
// metadata"; escaping: spec/architecture.md §6). Pure: no config, no DB — callers pass the
// absolute base URL (BLOG0_PUBLIC_BASE_URL) and the site/article values.

/** The default share card (public/og-default.png; designer-replaceable at the same name and size). */
export const OG_IMAGE = { path: '/og-default.png', width: 1200, height: 630 } as const;
/** The JSON-LD publisher logo (public/logo.png, 512×512). */
export const LOGO_PATH = '/logo.png';

/** `openGraph.images` for every public page (articles use the default image too). */
export function ogImageMetadata(brand: string): Array<{ url: string; width: number; height: number; alt: string }> {
  return [{ url: OG_IMAGE.path, width: OG_IMAGE.width, height: OG_IMAGE.height, alt: brand }];
}

/** `twitter` for every public page: the large card over the default image. */
export function twitterMetadata(t: { title: string; description?: string }): {
  card: 'summary_large_image';
  title: string;
  description?: string;
  images: string[];
} {
  return { card: 'summary_large_image', title: t.title, ...(t.description ? { description: t.description } : {}), images: [OG_IMAGE.path] };
}

/**
 * JSON for a `<script type="application/ld+json">` body: JSON.stringify, then every `<`, `>`, `&`,
 * U+2028 and U+2029 as a \u escape — still the same JSON value, but author text can never close
 * the element, open a comment or break a line terminator.
 */
export function serializeJsonLd(obj: unknown): string {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

export interface SiteSeo {
  /** The brand (the site's wordmark, e.g. "blog0"). */
  brand: string;
  /** Absolute origin, BLOG0_PUBLIC_BASE_URL. */
  baseUrl: string;
  /** The site's X / LinkedIn URLs that are set. */
  sameAs: string[];
}

function organization(s: SiteSeo, withSameAs: boolean): Record<string, unknown> {
  const base = trimBase(s.baseUrl);
  return {
    '@type': 'Organization',
    name: s.brand,
    url: base + '/',
    logo: base + LOGO_PATH,
    ...(withSameAs && s.sameAs.length ? { sameAs: s.sameAs } : {}),
  };
}

/** Home: one @graph with the Organization and the WebSite. */
export function homeJsonLd(s: SiteSeo): Record<string, unknown> {
  const base = trimBase(s.baseUrl);
  return {
    '@context': 'https://schema.org',
    '@graph': [organization(s, true), { '@type': 'WebSite', name: s.brand, url: base + '/' }],
  };
}

export interface ArticleSeo extends SiteSeo {
  slug: string;
  title: string;
  dek: string;
  authorName: string;
  firstPublishedAt: Date;
  contentUpdatedAt: Date | null;
}

/** Article page: the Article with its publisher; canonical = the absolute Read address. */
export function articleJsonLd(a: ArticleSeo): Record<string, unknown> {
  const base = trimBase(a.baseUrl);
  const url = `${base}/p/${a.slug}`;
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: a.title,
    ...(a.dek ? { description: a.dek } : {}),
    datePublished: a.firstPublishedAt.toISOString(),
    dateModified: (a.contentUpdatedAt ?? a.firstPublishedAt).toISOString(),
    author: { '@type': 'Person', name: a.authorName },
    publisher: organization(a, false),
    url,
    mainEntityOfPage: url,
    image: base + OG_IMAGE.path,
  };
}
