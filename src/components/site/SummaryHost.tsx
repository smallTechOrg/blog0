'use client';

import { useRouter } from 'next/navigation';
import { useMemo } from 'react';
import { createPortal } from 'react-dom';

import { TldrDeck } from '@/components/reader/TldrDeck';
import type { PublicTldrDto } from '@/lib/api/dto-phase2';
import { buildDeckSlides } from '@/lib/deck/timing';

/* ============================================================
   Summary overlay host — TLDR straight from a list page (design
   `App` → `summary.mode === 'tldr'` → TldrDeck). The deck opens over
   the list without changing the address; X / Escape close it and the
   deck itself puts the page back exactly where the reader left it.
   Rendered into the site root (a portal) so a transformed ancestor —
   the featured stack — can never trap the fixed-position deck.
   Listen from a card is Phase 3: the deck's Listen stays disabled.
   ============================================================ */

/** Endpoint for a card's deck (spec/api.md Phase 2). */
export function publicTldrUrl(slug: string): string {
  return '/api/public/articles/' + encodeURIComponent(slug) + '/tldr';
}

export interface SummaryHostProps {
  deck: PublicTldrDto;
  onClose: () => void;
}

export function SummaryHost({ deck, onClose }: SummaryHostProps) {
  const router = useRouter();
  const slides = useMemo(
    () => buildDeckSlides(deck.title, deck.dek, deck.slides.map((s) => s.text)),
    [deck.title, deck.dek, deck.slides],
  );
  if (typeof document === 'undefined') return null;
  const host = document.getElementById('blog0-root') ?? document.body;

  return createPortal(
    <TldrDeck
      key={deck.slug + '-deck'}
      slides={slides}
      title={deck.title}
      tag={deck.topic}
      meta={deck.meta}
      disclosure={deck.disclosure}
      shareLink={deck.shareUrl}
      times={deck.times}
      onClose={onClose}
      onRead={() => {
        onClose();
        router.push('/p/' + deck.slug);
      }}
    />,
    host,
  );
}
