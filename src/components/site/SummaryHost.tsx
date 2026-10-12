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
  /** The site record's wordmark for the deck's share text; omitted → read from the masthead. */
  brand?: string;
}

const HOME_LABEL_SUFFIX = ' — home';

/**
 * The site wordmark as the server-rendered masthead carries it (`aria-label="<wordmark> — home"`
 * on its home link, from the site record) — so a card's deck shares under the same brand as
 * the article page without threading the site through every list. Null when absent.
 */
export function siteBrandFromDocument(doc: Pick<Document, 'querySelector'>): string | null {
  const label = doc.querySelector('#blog0-root a.brandlink')?.getAttribute('aria-label') ?? '';
  if (!label.endsWith(HOME_LABEL_SUFFIX)) return null;
  const brand = label.slice(0, -HOME_LABEL_SUFFIX.length).trim();
  return brand || null;
}

export function SummaryHost({ deck, onClose, brand }: SummaryHostProps) {
  const router = useRouter();
  const slides = useMemo(
    () => buildDeckSlides(deck.title, deck.dek, deck.slides.map((s) => s.text)),
    [deck.title, deck.dek, deck.slides],
  );
  if (typeof document === 'undefined') return null;
  const host = document.getElementById('blog0-root') ?? document.body;
  const siteBrand = brand || siteBrandFromDocument(document) || undefined;

  return createPortal(
    <TldrDeck
      key={deck.slug + '-deck'}
      slides={slides}
      title={deck.title}
      tag={deck.topic}
      meta={deck.meta}
      disclosure={deck.disclosure}
      shareLink={deck.shareUrl}
      brand={siteBrand}
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
