import { rssFeed } from '@/server/public/metadata';
import { RSS_CONTENT_TYPE } from '@/server/public/rss';

// /feed.xml (spec/capabilities/reader-site.md "RSS feed"): RSS 2.0 of the 50 newest published
// articles, absolute from BLOG0_PUBLIC_BASE_URL. Read per request (never baked into the build),
// like /sitemap.xml, so a publish or unpublish shows up immediately.

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return new Response(await rssFeed(), {
    status: 200,
    headers: { 'Content-Type': RSS_CONTENT_TYPE },
  });
}
