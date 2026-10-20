'use client';

import Link from 'next/link';
import { useState } from 'react';

import { PostCard } from '@/components/site/PostCard';
import type { PostCardViewModel } from '@/lib/view-models';

export const FEED_BATCH = 5;
/** The beat See More holds before dealing the next batch (design loadMore). */
export const FEED_LOAD_MS = 280;

/* ============================================================
   Latest (design Home feed): every published article not in the Featured
   stack, newest first. Latest is a plain list — the scroll stack is the
   Featured section's job, and two stacking treatments on one page fight
   each other. Explicit paging: the reader asks for the next batch. No
   scroll listener.
   ============================================================ */
export interface LatestFeedProps {
  posts: PostCardViewModel[];
}

export function LatestFeed({ posts }: LatestFeedProps) {
  const [count, setCount] = useState(FEED_BATCH);
  const [loading, setLoading] = useState(false);
  const more = count < posts.length;

  function loadMore() {
    if (loading || !more) return;
    setLoading(true);
    window.setTimeout(() => {
      setCount((n) => Math.min(n + FEED_BATCH, posts.length));
      setLoading(false);
    }, FEED_LOAD_MS);
  }

  return (
    <section className="home-sec" aria-labelledby="feed-h">
      <div className="sechead">
        <h2 id="feed-h">Latest</h2>
      </div>
      {posts.slice(0, count).map((p) => (
        <PostCard key={p.slug} post={p} />
      ))}
      <div className="feed__cta">
        {more ? (
          <button
            type="button"
            className="btn-outline"
            onClick={loadMore}
            disabled={loading}
            aria-label="See more articles"
          >
            {loading ? 'Loading…' : 'See More'}
          </button>
        ) : (
          <p className="feed__status" aria-live="polite">
            That’s everything in the feed.
          </p>
        )}
        <Link className="btn-outline" href="/archive">
          View all articles
        </Link>
      </div>
    </section>
  );
}
