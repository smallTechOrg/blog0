// Hand-editing the TLDR draft deck (spec/ui.md §4 TLDR tab, capability jev-tldr). Pure.
// Text always comes from the server's sentence list; the client only orders sids.

import type { DeckSlideDto, GenerationDto, SaveDeckRequest, SentenceDto, TldrStateDto } from '@/lib/api/dto';

export type DeckLine = DeckSlideDto;

/** Hand-edited decks allow 1–12 lines (roadmap assumption). */
export const MAX_DECK_LINES = 12;

export function deckFromDraft(state: TldrStateDto | null): DeckLine[] {
  return state?.draft ? state.draft.slides.map((s) => ({ ...s })) : [];
}

/** Jev's latest picks rebuilt from the current sentences; picks whose sentence vanished are dropped. */
export function deckFromPicks(
  picks: NonNullable<GenerationDto['picks']>,
  sentences: readonly SentenceDto[],
): { lines: DeckLine[]; dropped: number } {
  const bySid = new Map(sentences.map((s) => [s.sid, s]));
  const lines: DeckLine[] = [];
  let dropped = 0;
  for (const p of picks) {
    const s = bySid.get(p.sid);
    if (!s) {
      dropped += 1;
      continue;
    }
    lines.push({ sid: s.sid, text: s.text, source: 'jev', relevance: p.relevance ?? s.relevance, missing: false });
  }
  return { lines, dropped };
}

/**
 * Re-flag lines against a fresh sentence list (after a save changed the text) and take each line's
 * relevance from it (a vanished or changed sentence has no score).
 */
export function reconcileDeck(deck: readonly DeckLine[], sentences: readonly SentenceDto[]): DeckLine[] {
  const bySid = new Map(sentences.map((s) => [s.sid, s]));
  return deck.map((l) => {
    const s = bySid.get(l.sid);
    const missing = !s || s.text !== l.text;
    const relevance = !s || missing ? null : s.relevance;
    return missing === l.missing && relevance === l.relevance ? l : { ...l, missing, relevance };
  });
}

/**
 * Check a sentence into the deck: at its document-order position when the present (non-missing)
 * lines are still in document order, otherwise appended. No-op when already in or the deck is full.
 */
export function addSentence(deck: DeckLine[], sentence: SentenceDto, sentences: readonly SentenceDto[]): DeckLine[] {
  if (deck.length >= MAX_DECK_LINES || deck.some((l) => l.sid === sentence.sid)) return deck;
  const indexOf = new Map(sentences.map((s) => [s.sid, s.index]));
  const fresh: DeckLine = { sid: sentence.sid, text: sentence.text, source: 'writer', relevance: sentence.relevance, missing: false };

  const present = deck
    .map((l, pos) => ({ pos, idx: l.missing ? undefined : indexOf.get(l.sid) }))
    .filter((x): x is { pos: number; idx: number } => x.idx !== undefined);
  const inOrder = present.every((x, i) => i === 0 || present[i - 1].idx < x.idx);
  if (!inOrder) return [...deck, fresh];

  const after = present.find((x) => x.idx > sentence.index);
  if (!after) return [...deck, fresh];
  return [...deck.slice(0, after.pos), fresh, ...deck.slice(after.pos)];
}

export function removeLine(deck: DeckLine[], sid: string): DeckLine[] {
  return deck.filter((l) => l.sid !== sid);
}

export function moveLine(deck: DeckLine[], pos: number, delta: -1 | 1): DeckLine[] {
  const to = pos + delta;
  if (pos < 0 || pos >= deck.length || to < 0 || to >= deck.length) return deck;
  const next = deck.slice();
  [next[pos], next[to]] = [next[to], next[pos]];
  return next;
}

export function toSaveSlides(deck: readonly DeckLine[]): SaveDeckRequest['slides'] {
  return deck.map((l) => ({ sid: l.sid, source: l.source }));
}

export function deckIsDirty(saved: readonly DeckLine[], current: readonly DeckLine[]): boolean {
  if (saved.length !== current.length) return true;
  return saved.some((l, i) => l.sid !== current[i].sid || l.source !== current[i].source);
}

export type PickerOrder = 'relevance' | 'article';

/** True when at least one sentence carries a relevance score (the picker can sort by it). */
export function hasScores(sentences: readonly SentenceDto[]): boolean {
  return sentences.some((s) => s.relevance !== null);
}

/**
 * Article lines by relevance (spec/ui.md §4 SentencePicker): highest score first on the raw number,
 * ties in document order, unscored sentences after all scored ones in document order.
 */
export function sortByRelevance(sentences: readonly SentenceDto[]): SentenceDto[] {
  return sentences.slice().sort((a, b) => {
    if (a.relevance === null || b.relevance === null) {
      if (a.relevance !== b.relevance) return a.relevance === null ? 1 : -1;
    } else if (a.relevance !== b.relevance) {
      return b.relevance - a.relevance;
    }
    return a.index - b.index;
  });
}

/** The section caption under a picker row: the sentence's last heading, or "Intro" before any. */
export function sectionOf(sentence: SentenceDto): string {
  return sentence.headingPath.at(-1) ?? 'Intro';
}
