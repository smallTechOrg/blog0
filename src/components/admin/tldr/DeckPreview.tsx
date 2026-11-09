'use client';

import { createPortal } from 'react-dom';

import { TldrDeck } from '@/components/reader/TldrDeck';
import { buildDeckSlides, tldrMinutes } from '@/lib/deck/timing';
import { deckDisclosure } from '@/lib/view-models';

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
  shareLink?: string;
  onClose: () => void;
}

export function DeckPreview({ title, dek, topic, dateLabel, readMinutes, lines, shareLink, onClose }: DeckPreviewProps) {
  const slides = buildDeckSlides(title, dek, lines.map((l) => l.text));
  const tldr = tldrMinutes(slides);
  const deck = (
    <TldrDeck
      slides={slides}
      title={title}
      tag={topic || undefined}
      meta={`${dateLabel} · ${readMinutes} min read`}
      disclosure={deckDisclosure(lines.map((l) => l.source))}
      shareLink={shareLink}
      times={{ read: readMinutes, tldr, listen: null }}
      onClose={onClose}
      onRead={onClose}
    />
  );
  return typeof document === 'undefined' ? null : createPortal(deck, document.body);
}
