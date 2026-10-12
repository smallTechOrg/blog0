import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import Link from 'next/link';

import { PostCard } from '@/components/site/PostCard';
import { StubNotice } from '@/components/StubNotice';
import { SESSION_COOKIE_NAME } from '@/server/auth/session';
import { getConfig } from '@/server/config';
import { getHomeViewModel } from '@/server/public/home';
import { sitePageMetadata } from '@/server/public/metadata';
import { getCurrentSite } from '@/server/site/current';

// Home (spec/ui.md §3 "Home", Phase 1): a labelled stub where About + Featured will go, then the
// real "Latest" list — every published article newest first as a PostCard, with the quick TLDR
// button only when a deck is published. Phase 2 replaces the stub with the design's sections.

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const site = await getCurrentSite();
  return sitePageMetadata({
    title: site.wordmark,
    description: site.tagline,
    url: getConfig().publicBaseUrl.replace(/\/+$/, '') + '/',
    siteName: site.wordmark,
  });
}

export default async function HomePage() {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value ?? null;
  const { posts, signedIn } = await getHomeViewModel(token);

  return (
    <main className="col">
      <section className="home-sec" aria-label="About and Featured Editorial">
        <StubNotice>Featured and About arrive in Phase 2.</StubNotice>
      </section>
      <section className="home-sec" aria-labelledby="feed-h">
        <div className="sechead">
          <h2 id="feed-h">Latest</h2>
        </div>
        {posts.length ? (
          posts.map((p) => <PostCard key={p.slug} post={p} />)
        ) : (
          <div className="feed__cta">
            <p className="feed__status" aria-live="polite">
              Nothing published yet.
            </p>
            {signedIn ? (
              <Link className="btn-outline" href="/admin">
                Go to the desk
              </Link>
            ) : null}
          </div>
        )}
      </section>
    </main>
  );
}
