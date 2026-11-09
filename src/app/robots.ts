import type { MetadataRoute } from 'next';

import { robotsRules } from '@/server/public/metadata';

// /robots.txt: the reader site is crawlable, /admin and /api/ are not; points at the sitemap.
// Per request so the sitemap URL follows the runtime BLOG0_PUBLIC_BASE_URL.

export const dynamic = 'force-dynamic';

export default function robots(): MetadataRoute.Robots {
  return robotsRules();
}
