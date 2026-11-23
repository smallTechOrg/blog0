// Hand-editing the TLDR draft deck (spec/ui.md §4 TLDR tab, capability jev-tldr). Pure.
// Text always comes from the server's sentence list; the client only orders sids.

import type { DeckImageDto, DeckSlideDto, GenerationDto, ImageUploadResponse, SaveDeckRequest, SentenceDto, TldrStateDto } from '@/lib/api/dto';

export type DeckLine = DeckSlideDto;

export function deckFromDraft(state: TldrStateDto | null): DeckLine[] {
  return state?.draft ? state.draft.slides.map((s) => ({ ...s })) : [];
}

/** The AI's latest picks rebuilt from the current sentences; picks whose sentence vanished are dropped. */
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
    if (l.image) return l; // an image is not a sentence of the article: it never goes missing
    const s = bySid.get(l.sid);
    const missing = !s || s.text !== l.text;
    const relevance = !s || missing ? null : s.relevance;
    return missing === l.missing && relevance === l.relevance ? l : { ...l, missing, relevance };
  });
}

/**
 * Check a sentence into the deck: at its document-order position when the present (non-missing)
 * lines are still in document order, otherwise appended. No-op when already in. A deck has no upper length limit.
 */
export function addSentence(deck: DeckLine[], sentence: SentenceDto, sentences: readonly SentenceDto[]): DeckLine[] {
  if (deck.some((l) => l.sid === sentence.sid)) return deck;
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

/** A freshly uploaded image as a deck line (SMA-49): `sid` is `img:<assetId>`, the caption starts empty. */
export function imageLine(asset: ImageUploadResponse['asset'], alt: string): DeckLine {
  const image: DeckImageDto = { assetId: asset.id, key: asset.key, url: asset.url, alt, width: asset.width, height: asset.height };
  return { sid: `img:${asset.id}`, text: '', source: 'image', relevance: null, missing: false, image };
}

/** Appends an image line; no-op when that image is already in the deck. */
export function addImage(deck: DeckLine[], line: DeckLine): DeckLine[] {
  return deck.some((l) => l.sid === line.sid) ? deck : [...deck, line];
}

/** Edits an image line's caption and/or alt text. */
export function editImage(deck: DeckLine[], sid: string, patch: { text?: string; alt?: string }): DeckLine[] {
  return deck.map((l) =>
    l.sid === sid && l.image ? { ...l, text: patch.text ?? l.text, image: { ...l.image, alt: patch.alt ?? l.image.alt } } : l,
  );
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
  return deck.map((l) =>
    l.source === 'image' && l.image
      ? { sid: l.sid, source: 'image' as const, assetId: l.image.assetId, text: l.text, alt: l.image.alt }
      : { sid: l.sid, source: l.source === 'image' ? ('writer' as const) : l.source },
  );
}

export function deckIsDirty(saved: readonly DeckLine[], current: readonly DeckLine[]): boolean {
  if (saved.length !== current.length) return true;
  return saved.some((l, i) => l.sid !== current[i].sid || l.source !== current[i].source || l.text !== current[i].text || l.image?.alt !== current[i].image?.alt);
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
