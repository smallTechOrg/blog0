'use client';

import { createPortal } from 'react-dom';

import { TldrDeck } from '@/components/reader/TldrDeck';
import { buildDeckSlides, tldrMinutes } from '@/lib/deck/timing';

import type { DeckLine } from './deck-edit';

// "Preview deck": the real reader TldrDeck over the editor, playing the current (unsaved) draft
// exactly as readers will see it once published. Portalled to <body> so no editor stacking
// context can clip the fixed deck.

export interface DeckPreviewProps {
  title: string;
  dek: string;
  topic: string;
  dateLabel: string;
  readMinutes: number;
  lines: readonly DeckLine[];
  /** A slideshow-only post: no Read hand-over. */
  mediaOnly?: boolean;
  shareLink?: string;
  onClose: () => void;
}

export function DeckPreview({ title, dek, topic, dateLabel, readMinutes, lines, mediaOnly, shareLink, onClose }: DeckPreviewProps) {
  const slides = buildDeckSlides(
    title,
    dek,
    lines.map((l) => (l.image ? { text: l.text, image: { url: l.image.url, alt: l.image.alt } } : { text: l.text })),
  );
  const tldr = tldrMinutes(slides);
  const deck = (
    <TldrDeck
      slides={slides}
      title={title}
      tag={topic || undefined}
      meta={`${dateLabel} · ${readMinutes} min read`}
      shareLink={shareLink}
      times={{ read: readMinutes, tldr, listen: null }}
      slideshow={mediaOnly}
      onClose={onClose}
      onRead={onClose}
    />
  );
  return typeof document === 'undefined' ? null : createPortal(deck, document.body);
}
