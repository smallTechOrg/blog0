'use client';

import { useRouter } from 'next/navigation';
import { useMemo } from 'react';
import { createPortal } from 'react-dom';

import { TldrDeck } from '@/components/reader/TldrDeck';
import type { PublicTldrDto } from '@/lib/api/dto';
import type { PublicListenDto } from '@/lib/api/dto';
import { buildDeckSlides } from '@/lib/deck/timing';

import { ListenOverlay } from './ListenOverlay';

/* ============================================================
   Summary overlay host — TLDR or Listen straight from a list page (design
   `App` → `summary.mode`): the deck or the compact player opens over the
   list without changing the address; X / Escape close it and the page is
   put back exactly where the reader left it. The two hand over to each
   other for the same post (deck's Listen ↔ overlay's TLDR) through
   `onSwitch`; the card loads whichever payload is still missing.
   Rendered into the site root (a portal) so a transformed ancestor —
   the featured stack — can never trap the fixed-position sheet.
   ============================================================ */

/** Endpoint for a card's deck (spec/api.md). */
export function publicTldrUrl(slug: string): string {
  return '/api/public/articles/' + encodeURIComponent(slug) + '/tldr';
}

/** Endpoint for a card's recording (spec/api.md). */
export function publicListenUrl(slug: string): string {
  return '/api/public/articles/' + encodeURIComponent(slug) + '/listen';
}

export type SummaryMode = 'tldr' | 'listen';

export interface SummaryHostProps {
  mode: SummaryMode;
  slug: string;
  /** Required in `tldr` mode. */
  deck?: PublicTldrDto | null;
  /** Required in `listen` mode. */
  listen?: PublicListenDto | null;
  /** The other mode is available for this post (the capsule button is enabled). */
  canSwitch: { tldr: boolean; listen: boolean };
  onSwitch: (mode: SummaryMode) => void;
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

export function SummaryHost({ mode, slug, deck, listen, canSwitch, onSwitch, onClose, brand }: SummaryHostProps) {
  const router = useRouter();
  const slides = useMemo(
    () => (deck ? buildDeckSlides(deck.title, deck.dek, deck.slides.map((s) => s.text)) : []),
    [deck],
  );
  if (typeof document === 'undefined') return null;
  const host = document.getElementById('blog0-root') ?? document.body;
  const siteBrand = brand || siteBrandFromDocument(document) || undefined;
  const openArticle = () => {
    onClose();
    router.push('/p/' + slug);
  };

  if (mode === 'listen') {
    if (!listen) return null;
    return createPortal(
      <ListenOverlay
        key={slug + '-listen'}
        listen={listen}
        onClose={onClose}
        onRead={openArticle}
        onTldr={canSwitch.tldr ? () => onSwitch('tldr') : undefined}
      />,
      host,
    );
  }

  if (!deck) return null;
  return createPortal(
    <TldrDeck
      key={slug + '-deck'}
      slides={slides}
      title={deck.title}
      tag={deck.topic}
      meta={deck.meta}
      disclosure={deck.disclosure}
      shareLink={deck.shareUrl}
      brand={siteBrand}
      times={deck.times}
      onClose={onClose}
      onRead={openArticle}
      onListen={canSwitch.listen ? () => onSwitch('listen') : undefined}
    />,
    host,
  );
}
