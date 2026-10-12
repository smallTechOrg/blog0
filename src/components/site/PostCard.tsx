'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type CSSProperties } from 'react';

import { Dek } from '@/components/design/Dek';
import { Icon } from '@/components/design/Icon';
import { cx, dekDelay } from '@/components/design/motion';
import { SplitHeadline } from '@/components/design/SplitHeadline';
import type { PublicTldrDto } from '@/lib/api/dto-phase2';
import type { Envelope } from '@/lib/api/envelope';
import type { PostCardViewModel } from '@/lib/view-models';

import { publicTldrUrl, SummaryHost } from './SummaryHost';

/* ============================================================
   Post rows (design PostCard). The quick TLDR button appears only when a
   published deck exists and opens the deck over the list (SummaryHost) with
   data from GET /api/public/articles/<slug>/tldr: while loading the button is
   disabled and shows "…"; on failure it reads "Couldn’t load" for 2 s.
   Listen is hidden until an article has published audio (divergence 9).
   ============================================================ */

/** How long the TLDR button says "Couldn’t load" before it resets (spec/ui.md §3 Home). */
export const TLDR_ERROR_MS = 2000;

type TldrState = 'idle' | 'loading' | 'error';

async function fetchDeck(slug: string): Promise<PublicTldrDto> {
  const res = await fetch(publicTldrUrl(slug), { headers: { accept: 'application/json' } });
  const env = (await res.json()) as Envelope<PublicTldrDto>;
  if (!res.ok || !env.ok) throw new Error(env.ok ? 'HTTP ' + res.status : env.error.code);
  return env.data;
}
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

  const [tldr, setTldr] = useState<TldrState>('idle');
  const [deck, setDeck] = useState<PublicTldrDto | null>(null);
  const [open, setOpen] = useState(false);
  const errTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (errTimer.current) clearTimeout(errTimer.current);
    },
    [],
  );

  async function openDeck() {
    if (deck) {
      setOpen(true);
      return;
    }
    if (tldr === 'loading') return;
    setTldr('loading');
    try {
      const d = await fetchDeck(p.slug);
      setDeck(d);
      setTldr('idle');
      setOpen(true);
    } catch {
      setTldr('error');
      if (errTimer.current) clearTimeout(errTimer.current);
      errTimer.current = setTimeout(() => setTldr('idle'), TLDR_ERROR_MS);
    }
  }

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
              disabled={tldr === 'loading'}
              aria-busy={tldr === 'loading' || undefined}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                void openDeck();
              }}
              aria-label={
                tldr === 'error'
                  ? 'Couldn’t load the summary of ' + p.title
                  : 'Summary of ' + p.title + ' — ' + p.times.tldr + ' min'
              }
            >
              <Icon name="bolt" size={14} />
              <span>{tldr === 'error' ? 'Couldn’t load' : 'TLDR'}</span>
              {tldr === 'error' ? null : (
                <span className="quick__d">{tldr === 'loading' ? '…' : p.times.tldr + ' min'}</span>
              )}
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
      {open && deck ? <SummaryHost deck={deck} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}
