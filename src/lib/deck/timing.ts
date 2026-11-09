// TLDR deck timing + type scale, ported verbatim from spec/design/design-app.js
// (tldrWords, tldrDwell, tldrType, tldrMinutes, tdeckSlide, TDECK_* constants).
// Pure + isomorphic: used by the reader deck, the admin deck preview and the public queries.

export const TDECK_STEP_MS = 720;
export const TDECK_WHEEL = 90; /* accumulated delta that commits a step */
export const TDECK_SWIPE = 56; /* px of drag that commits a step */

/* How a slide lays out when it has no image. A slide that DOES carry one
   always uses 'split', so this only governs the image-less case.
     'column' — ordinal over a centred measure, rule, sentence ranged left
     'hero'   — the sentence is the composition, ordinal as a kicker
     'split'  — the two-column figure layout, with the ordinal as the figure */
export type DeckLayout = 'column' | 'hero' | 'split';
export const TDECK_LAYOUT: DeckLayout = 'column';

/** One slide of the deck. The first slide of a real deck is the intro title card. */
export interface DeckSlide {
  kind?: 'intro' | 'line';
  text: string;
  /** Intro only: the stand line under the title (the article's dek). */
  sub?: string;
  img?: string;
  alt?: string;
}

/* A TL;DR entry is a plain string, or an object once it has art:
   { text: '…', img: '…', alt: '…' } */
export function tdeckSlide(s: DeckSlide | string): DeckSlide {
  return s && typeof s === 'object' ? s : { text: String(s) };
}

/** The deck the reader sees: the title card, then one slide per published line, in order. */
export function buildDeckSlides(title: string, dek: string, lines: readonly string[]): DeckSlide[] {
  const intro: DeckSlide = dek ? { kind: 'intro', text: title, sub: dek } : { kind: 'intro', text: title };
  return [intro, ...lines.map((text): DeckSlide => ({ kind: 'line', text }))];
}

/* How long a slide holds before the deck moves on: roughly the time it
   takes to read it, floored so a short line isn't a flash and capped so a
   long one doesn't stall. */
export function tldrWords(s: Pick<DeckSlide, 'text'> | null | undefined): number {
  return String((s && s.text) || '').trim().split(/\s+/).length;
}

export function tldrDwell(sl: Pick<DeckSlide, 'kind' | 'text'> | null | undefined): number {
  /* the title card is a beat, not a read */
  if (sl && sl.kind === 'intro') return 3800;
  const w = tldrWords(sl);
  return Math.round(Math.max(2800, Math.min(9000, 1100 + (w / 3.1) * 1000)));
}

/* Type scales with the sentence: six words fill the screen, forty don't. */
export function tldrType(sl: Pick<DeckSlide, 'text'>): string {
  const w = tldrWords(sl);
  const px = Math.round(Math.max(23, Math.min(58, 60 - (w - 6) * 0.85)));
  /* the floor scales too, or every slide bottoms out at the same size on a
     phone and the difference between a short line and a long one is lost */
  const min = Math.round(Math.max(17, Math.min(30, px * 0.44)));
  return 'clamp(' + min + 'px, ' + (px / 7.2).toFixed(2) + 'vw, ' + px + 'px)';
}

/** ~180 words a minute over the whole deck (title card included), rounded, at least 1 — the
 *  design's "TLDR n min" badge. Pass the full deck from `buildDeckSlides`. */
export function tldrMinutes(slides: ReadonlyArray<Pick<DeckSlide, 'text'>>): number {
  let w = 0;
  slides.forEach((s) => {
    w += tldrWords(s);
  });
  return Math.max(1, Math.round(w / 180));
}
