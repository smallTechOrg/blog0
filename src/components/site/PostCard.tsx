'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type CSSProperties } from 'react';

import { Dek } from '@/components/design/Dek';
import { Icon } from '@/components/design/Icon';
import { cx, dekDelay } from '@/components/design/motion';
import { SplitHeadline } from '@/components/design/SplitHeadline';
import type { PublicTldrDto } from '@/lib/api/dto';
import type { PublicListenDto } from '@/lib/api/dto';
import type { Envelope } from '@/lib/api/envelope';
import type { PostCardViewModel } from '@/lib/view-models';

import { publicListenUrl, publicTldrUrl, SummaryHost, type SummaryMode } from './SummaryHost';

/* ============================================================
   Post rows (design PostCard). The quick TLDR / Listen buttons appear only
   when the published deck / recording exists and open the deck or the
   compact player over the list (SummaryHost) with data from
   GET /api/public/articles/<slug>/{tldr,listen}: while loading the button
   is disabled and shows "…"; on failure it reads "Couldn’t load" for 2 s.
   The two hand over to each other inside the overlay (same post).
   ============================================================ */

/** How long a quick button says "Couldn’t load" before it resets (spec/ui.md §3 Home). */
export const TLDR_ERROR_MS = 2000;

type QuickState = 'idle' | 'loading' | 'error';

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  const env = (await res.json()) as Envelope<T>;
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
  /* the card assembles: tag row, then the headline word by word, then the
     excerpt. Capped shorter than an article H1 so a scrolling feed keeps up. */
  const excerptDelay = Math.min(dekDelay(p.title), 700);
  const cls = variant === 'card' ? 'fcard' : variant === 'card-lead' ? 'fcard fcard--lead' : 'post';
  const hasQuick = p.times.tldr != null || p.times.listen != null;

  const [state, setState] = useState<Record<SummaryMode, QuickState>>({ tldr: 'idle', listen: 'idle' });
  const [deck, setDeck] = useState<PublicTldrDto | null>(null);
  const [listen, setListen] = useState<PublicListenDto | null>(null);
  const [open, setOpen] = useState<SummaryMode | null>(null);
  const errTimer = useRef<Partial<Record<SummaryMode, ReturnType<typeof setTimeout>>>>({});
  useEffect(
    () => () => {
      for (const t of Object.values(errTimer.current)) if (t) clearTimeout(t);
    },
    [],
  );

  function setQuick(mode: SummaryMode, s: QuickState) {
    setState((prev) => ({ ...prev, [mode]: s }));
  }

  /** Loads the mode's payload (once) and opens it over the list. */
  async function openMode(mode: SummaryMode) {
    if (mode === 'tldr' ? deck : listen) {
      setOpen(mode);
      return;
    }
    if (state[mode] === 'loading') return;
    setQuick(mode, 'loading');
    try {
      if (mode === 'tldr') setDeck(await fetchJson<PublicTldrDto>(publicTldrUrl(p.slug)));
      else setListen(await fetchJson<PublicListenDto>(publicListenUrl(p.slug)));
      setQuick(mode, 'idle');
      setOpen(mode);
    } catch {
      setQuick(mode, 'error');
      const t = errTimer.current[mode];
      if (t) clearTimeout(t);
      errTimer.current[mode] = setTimeout(() => setQuick(mode, 'idle'), TLDR_ERROR_MS);
    }
  }

  function quickButton(mode: SummaryMode, min: number) {
    const s = state[mode];
    const label = mode === 'tldr' ? 'TLDR' : 'Listen';
    const what = mode === 'tldr' ? 'Summary of ' + p.title : 'Listen to ' + p.title;
    return (
      <button
        type="button"
        className="quick__btn"
        disabled={s === 'loading'}
        aria-busy={s === 'loading' || undefined}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void openMode(mode);
        }}
        aria-label={s === 'error' ? 'Couldn’t load ' + (mode === 'tldr' ? 'the summary of ' : 'the recording of ') + p.title : what + ' — ' + min + ' min'}
      >
        <Icon name={mode === 'tldr' ? 'bolt' : 'headphones'} size={14} />
        <span>{s === 'error' ? 'Couldn’t load' : label}</span>
        {s === 'error' ? null : <span className="quick__d">{s === 'loading' ? '…' : min + ' min'}</span>}
      </button>
    );
  }

  return (
    <div className={cls} style={i != null ? ({ '--i': String(i) } as CSSProperties) : undefined}>
      <Link className="post__link" href={'/p/' + p.slug}>
        <Dek tag="div" className="post__top" delay={0}>
          <span className="tag">{p.topic}</span>
          {p.inProgress ? <span className="tag tag--draft">Draft</span> : null}
          {/* A featured card may be evergreen and carry no date, but the row is
              reserved either way so featured and regular cards line up. */}
          <span className={cx('meta', !p.publishedLabel && 'meta--empty')}>{p.publishedLabel || ' '}</span>
        </Dek>
        <SplitHeadline tag="h3" text={p.title} />
        <Dek tag="p" delay={excerptDelay}>
          {p.dek}
        </Dek>
      </Link>
      {/* skim it, or hear it, without leaving the list — held back on the same
          beat as the excerpt, so the card assembles as one thing */}
      {hasQuick ? (
        <Dek tag="div" className="quick" delay={excerptDelay}>
          {p.times.tldr != null ? quickButton('tldr', p.times.tldr) : null}
          {p.times.listen != null ? quickButton('listen', p.times.listen) : null}
        </Dek>
      ) : null}
      {open ? (
        <SummaryHost
          mode={open}
          slug={p.slug}
          deck={deck}
          listen={listen}
          canSwitch={{ tldr: p.times.tldr != null, listen: p.times.listen != null }}
          onSwitch={(mode) => void openMode(mode)}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
}
