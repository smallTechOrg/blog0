'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { CSSProperties } from 'react';

import { Dek } from '@/components/design/Dek';
import { Icon } from '@/components/design/Icon';
import { cx, dekDelay } from '@/components/design/motion';
import { SplitHeadline } from '@/components/design/SplitHeadline';
import type { PostCardViewModel } from '@/lib/view-models';

/* ============================================================
   Post rows (design PostCard). Phase 1: the quick TLDR button goes to
   /p/<slug>/tldr and appears only when a published deck exists; Listen is
   hidden until an article has published audio (divergence 9).
   ============================================================ */
export type PostCardVariant = 'post' | 'card' | 'card-lead';

export interface PostCardProps {
  post: PostCardViewModel;
  variant?: PostCardVariant;
  /** Position in a featured stack (sets `--i`). */
  i?: number;
}

export function PostCard({ post: p, variant = 'post', i }: PostCardProps) {
  const router = useRouter();
  /* the card assembles: tag row, then the headline word by word, then the
     excerpt. Capped shorter than an article H1 so a scrolling feed keeps up. */
  const excerptDelay = Math.min(dekDelay(p.title), 700);
  const cls = variant === 'card' ? 'fcard' : variant === 'card-lead' ? 'fcard fcard--lead' : 'post';
  const hasQuick = p.times.tldr != null || p.times.listen != null;

  return (
    <div className={cls} style={i != null ? ({ '--i': String(i) } as CSSProperties) : undefined}>
      <Link className="post__link" href={'/p/' + p.slug}>
        <Dek tag="div" className="post__top" delay={0}>
          <span className="tag">{p.topic}</span>
          {p.inProgress ? <span className="tag tag--draft">Draft</span> : null}
          {/* A featured card may be evergreen and carry no date, but the row is
              reserved either way so featured and regular cards line up. */}
          <span className={cx('meta', !p.publishedLabel && 'meta--empty')}>{p.publishedLabel || ' '}</span>
        </Dek>
        <SplitHeadline tag="h3" text={p.title} />
        <Dek tag="p" delay={excerptDelay}>
          {p.dek}
        </Dek>
      </Link>
      {/* skim it without leaving the list — held back on the same beat as the
          excerpt, so the card assembles as one thing */}
      {hasQuick ? (
        <Dek tag="div" className="quick" delay={excerptDelay}>
          {p.times.tldr != null ? (
            <button
              type="button"
              className="quick__btn"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                router.push('/p/' + p.slug + '/tldr');
              }}
              aria-label={'Summary of ' + p.title + ' — ' + p.times.tldr + ' min'}
            >
              <Icon name="bolt" size={14} />
              <span>TLDR</span>
              <span className="quick__d">{p.times.tldr + ' min'}</span>
            </button>
          ) : null}
          {p.times.listen != null ? (
            <button
              type="button"
              className="quick__btn"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                router.push('/p/' + p.slug + '/listen');
              }}
              aria-label={'Listen to ' + p.title + ' — ' + p.times.listen + ' min'}
            >
              <Icon name="headphones" size={14} />
              <span>Listen</span>
              <span className="quick__d">{p.times.listen + ' min'}</span>
            </button>
          ) : null}
        </Dek>
      ) : null}
    </div>
  );
}
