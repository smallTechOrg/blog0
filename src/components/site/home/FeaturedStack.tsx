'use client';

import { useEffect, useRef, type KeyboardEvent } from 'react';

import { prefersReducedMotion } from '@/components/design/motion';
import { PostCard } from '@/components/site/PostCard';
import type { PostCardViewModel } from '@/lib/view-models';

/* ============================================================
   Featured Editorial (design Home, FEATURED_MODE = 'stack'): a pinned
   section head over a scroll stack of lead-size cards. All of them are
   lead-size, so the pile is even rather than one big card and two small.
   ============================================================ */
export interface FeaturedStackProps {
  /** Already ordered and capped (src/server/public/home.ts). */
  posts: PostCardViewModel[];
}

export function FeaturedStack({ posts }: FeaturedStackProps) {
  const featRef = useRef<HTMLElement>(null);
  const stackRef = useRef<HTMLDivElement>(null);

  /* Cards settle onto the pile as they come into view. The class goes on the
     container first, so a browser without IntersectionObserver never hides
     the cards it then can't reveal. */
  useEffect(() => {
    const el = stackRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    el.classList.add('stack--on');
    /* Two-way: a card settles onto the pile coming down and lifts back off
       going up, so reversing the scroll reverses the animation instead of
       leaving every card stuck in its landed state. */
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((en) => {
          en.target.classList.toggle('is-settled', en.isIntersecting);
        });
      },
      { threshold: 0.04, rootMargin: '0px 0px -4% 0px' },
    );
    const cards = el.children;
    for (let i = 0; i < cards.length; i++) io.observe(cards[i]);
    return () => io.disconnect();
  }, [posts.length]);

  /* The pinned Featured head is the way out of the pile: one click puts the
     section back at its resting position under the site header, and the
     cards unstack as the page settles there. */
  function unstack() {
    const el = featRef.current;
    if (!el) return;
    const head = document.querySelector('.sitehead');
    const hh = head ? head.getBoundingClientRect().height : 0;
    const y =
      el.getBoundingClientRect().top + (window.pageYOffset || document.documentElement.scrollTop || 0) - hh - 8;
    try {
      window.scrollTo({ top: Math.max(0, y), behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    } catch {
      window.scrollTo(0, Math.max(0, y));
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      unstack();
    }
  }

  if (!posts.length) return null;
  return (
    <section className="home-sec home-sec--pinned" aria-labelledby="feat-h" ref={featRef}>
      <div
        className="sechead sechead--pin"
        role="button"
        tabIndex={0}
        title="Back to the top of Featured"
        onClick={unstack}
        onKeyDown={onKeyDown}
      >
        <h2 id="feat-h">Featured Editorial</h2>
        <span className="sechead__hint" aria-hidden="true">
          ↑ top
        </span>
      </div>
      {/* The scroll stack: each featured card settles on top of the one before it. */}
      <div className="stack" ref={stackRef}>
        {posts.map((p, i) => (
          <PostCard key={p.slug} post={p} variant="card-lead" i={i} />
        ))}
      </div>
    </section>
  );
}
