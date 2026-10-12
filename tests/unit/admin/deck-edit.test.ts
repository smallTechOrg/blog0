import { describe, expect, it } from 'vitest';

import {
  addSentence,
  deckFromDraft,
  deckFromPicks,
  deckIsDirty,
  MAX_DECK_LINES,
  moveLine,
  reconcileDeck,
  removeLine,
  toSaveSlides,
  type DeckLine,
} from '@/components/admin/tldr/deck-edit';
import type { SentenceDto, TldrStateDto } from '@/lib/api/dto';

function sentence(i: number, headingPath: string[] = []): SentenceDto {
  return { sid: `s${i}`, index: i, pid: `p-${i}`, text: `Sentence number ${i} is long enough.`, words: 6, headingPath };
}

const SENTENCES = [0, 1, 2, 3, 4, 5].map((i) => sentence(i));

function line(i: number, source: 'jev' | 'writer' = 'jev'): DeckLine {
  return { sid: `s${i}`, text: SENTENCES[i].text, source, reason: source === 'jev' ? `reason ${i}` : null, missing: false };
}

describe('addSentence', () => {
  it('inserts a sentence at its document-order position when the deck is in document order', () => {
    const deck = [line(0), line(3)];

    const next = addSentence(deck, SENTENCES[1], SENTENCES);

    expect(next.map((l) => l.sid)).toEqual(['s0', 's1', 's3']);
    expect(next[1]).toMatchObject({ source: 'writer', reason: null, missing: false, text: SENTENCES[1].text });
  });

  it('appends when the writer has reordered the deck out of document order', () => {
    const deck = [line(3), line(0)];

    const next = addSentence(deck, SENTENCES[1], SENTENCES);

    expect(next.map((l) => l.sid)).toEqual(['s3', 's0', 's1']);
  });

  it('ignores missing lines when judging document order and appends after the last later line', () => {
    const missing: DeckLine = { sid: 'gone', text: 'Old text.', source: 'jev', reason: 'r', missing: true };
    const deck = [line(0), missing, line(4)];

    const next = addSentence(deck, SENTENCES[5], SENTENCES);

    expect(next.map((l) => l.sid)).toEqual(['s0', 'gone', 's4', 's5']);
  });

  it('does not add a sentence twice or beyond the line limit', () => {
    const deck = [line(0)];
    expect(addSentence(deck, SENTENCES[0], SENTENCES)).toBe(deck);

    const full: DeckLine[] = Array.from({ length: MAX_DECK_LINES }, (_, i) => ({ ...line(0), sid: `x${i}` }));
    expect(addSentence(full, SENTENCES[1], SENTENCES)).toBe(full);
  });
});

describe('moveLine / removeLine', () => {
  it('moves a line up and down and clamps at the ends', () => {
    const deck = [line(0), line(1), line(2)];

    expect(moveLine(deck, 2, -1).map((l) => l.sid)).toEqual(['s0', 's2', 's1']);
    expect(moveLine(deck, 0, 1).map((l) => l.sid)).toEqual(['s1', 's0', 's2']);
    expect(moveLine(deck, 0, -1)).toBe(deck);
    expect(moveLine(deck, 2, 1)).toBe(deck);
  });

  it('removes a line by sid', () => {
    expect(removeLine([line(0), line(1)], 's0').map((l) => l.sid)).toEqual(['s1']);
  });
});

describe('deck conversions', () => {
  it('builds the save payload with source and reason only', () => {
    expect(toSaveSlides([line(0), line(1, 'writer')])).toEqual([
      { sid: 's0', source: 'jev', reason: 'reason 0' },
      { sid: 's1', source: 'writer', reason: null },
    ]);
  });

  it('reads the draft deck from the TLDR state, or an empty deck when there is none', () => {
    const state = { draft: { slides: [line(2)], revisionId: 'r', updatedAt: '', updatedBy: '' } } as unknown as TldrStateDto;

    expect(deckFromDraft(state)).toEqual([line(2)]);
    expect(deckFromDraft({ draft: null } as unknown as TldrStateDto)).toEqual([]);
    expect(deckFromDraft(null)).toEqual([]);
  });

  it("rebuilds Jev's picks from the current sentence list and reports picks that vanished", () => {
    const { lines, dropped } = deckFromPicks(
      [
        { index: 1, sid: 's1', reason: 'why 1' },
        { index: 9, sid: 'gone', reason: 'why gone' },
      ],
      SENTENCES,
    );

    expect(lines).toEqual([{ sid: 's1', text: SENTENCES[1].text, source: 'jev', reason: 'why 1', missing: false }]);
    expect(dropped).toBe(1);
  });

  it('flags lines whose sentence is no longer in the article after a re-render', () => {
    const deck = [line(0), line(1)];

    const next = reconcileDeck(deck, [SENTENCES[1]]);

    expect(next.map((l) => [l.sid, l.missing])).toEqual([
      ['s0', true],
      ['s1', false],
    ]);
  });

  it('detects a dirty deck by order, membership and source', () => {
    const saved = [line(0), line(1)];

    expect(deckIsDirty(saved, [line(0), line(1)])).toBe(false);
    expect(deckIsDirty(saved, [line(1), line(0)])).toBe(true);
    expect(deckIsDirty(saved, [line(0)])).toBe(true);
    expect(deckIsDirty(saved, [line(0), line(1, 'writer')])).toBe(true);
  });
});
