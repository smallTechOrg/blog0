import type { MetadataRoute } from 'next';

import { sitemapEntries } from '@/server/public/metadata';

// /sitemap.xml (spec/capabilities/reader-site.md): `/`, `/archive`, `/about` and every published
// article's Read address, absolute from BLOG0_PUBLIC_BASE_URL. Read per request (never baked into
// the build), so a publish or unpublish shows up immediately.

export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  return sitemapEntries();
}
