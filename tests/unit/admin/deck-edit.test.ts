import { describe, expect, it } from 'vitest';

import {
  addSentence,
  deckFromDraft,
  deckFromPicks,
  deckIsDirty,
  hasScores,
  MAX_DECK_LINES,
  moveLine,
  reconcileDeck,
  removeLine,
  sectionOf,
  sortByRelevance,
  toSaveSlides,
  type DeckLine,
} from '@/components/admin/tldr/deck-edit';
import type { SentenceDto, TldrStateDto } from '@/lib/api/dto';

function sentence(i: number, headingPath: string[] = [], relevance: number | null = null): SentenceDto {
  return { sid: `s${i}`, index: i, pid: `p-${i}`, text: `Sentence number ${i} is long enough.`, words: 6, headingPath, relevance };
}

const SCORES = [0.31, 0.9, 0.12, 0.77, 0.5, 0.05];
const SENTENCES = [0, 1, 2, 3, 4, 5].map((i) => sentence(i, [], SCORES[i]));

function line(i: number, source: 'jev' | 'writer' = 'jev'): DeckLine {
  return { sid: `s${i}`, text: SENTENCES[i].text, source, relevance: SCORES[i], missing: false };
}

describe('addSentence', () => {
  it('inserts a sentence at its document-order position when the deck is in document order', () => {
    const deck = [line(0), line(3)];

    const next = addSentence(deck, SENTENCES[1], SENTENCES);

    expect(next.map((l) => l.sid)).toEqual(['s0', 's1', 's3']);
    expect(next[1]).toMatchObject({ source: 'writer', relevance: 0.9, missing: false, text: SENTENCES[1].text });
    expect(next[1]).not.toHaveProperty('reason');
  });

  it('adds an unscored sentence with relevance null', () => {
    const next = addSentence([], sentence(2), [sentence(2)]);
    expect(next).toEqual([{ sid: 's2', text: sentence(2).text, source: 'writer', relevance: null, missing: false }]);
  });

  it('appends when the writer has reordered the deck out of document order', () => {
    const deck = [line(3), line(0)];

    const next = addSentence(deck, SENTENCES[1], SENTENCES);

    expect(next.map((l) => l.sid)).toEqual(['s3', 's0', 's1']);
  });

  it('ignores missing lines when judging document order and appends after the last later line', () => {
    const missing: DeckLine = { sid: 'gone', text: 'Old text.', source: 'jev', relevance: null, missing: true };
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
  it('builds the save payload with sid and source only (no reason, no relevance — the server owns scores)', () => {
    expect(toSaveSlides([line(0), line(1, 'writer')])).toEqual([
      { sid: 's0', source: 'jev' },
      { sid: 's1', source: 'writer' },
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
        { index: 1, sid: 's1', relevance: 0.91 },
        { index: 3, sid: 's3', relevance: null },
        { index: 9, sid: 'gone', relevance: 0.8 },
      ],
      SENTENCES,
    );

    expect(lines).toEqual([
      { sid: 's1', text: SENTENCES[1].text, source: 'jev', relevance: 0.91, missing: false },
      // a legacy pick without a score falls back to the sentence's current score
      { sid: 's3', text: SENTENCES[3].text, source: 'jev', relevance: 0.77, missing: false },
    ]);
    expect(dropped).toBe(1);
  });

  it('flags lines whose sentence is no longer in the article after a re-render', () => {
    const deck = [line(0), line(1)];

    const next = reconcileDeck(deck, [SENTENCES[1]]);

    expect(next.map((l) => [l.sid, l.missing, l.relevance])).toEqual([
      ['s0', true, null],
      ['s1', false, 0.9],
    ]);
  });

  it('takes the relevance of an unchanged line from the fresh sentence list (null once the score is gone)', () => {
    const deck = [line(0), line(1)];
    const fresh = [sentence(0, [], null), SENTENCES[1]];

    const next = reconcileDeck(deck, fresh);

    expect(next.map((l) => [l.sid, l.missing, l.relevance])).toEqual([
      ['s0', false, null],
      ['s1', false, 0.9],
    ]);
    expect(next[1]).toBe(deck[1]); // unchanged lines keep their identity
  });

  it('detects a dirty deck by order, membership and source', () => {
    const saved = [line(0), line(1)];

    expect(deckIsDirty(saved, [line(0), line(1)])).toBe(false);
    expect(deckIsDirty(saved, [line(1), line(0)])).toBe(true);
    expect(deckIsDirty(saved, [line(0)])).toBe(true);
    expect(deckIsDirty(saved, [line(0), line(1, 'writer')])).toBe(true);
  });
});

describe('sorting article lines by relevance', () => {
  it('orders by score descending on the raw number, ties in document order, unscored last in document order', () => {
    const list = [
      sentence(0, [], null),
      sentence(1, [], 0.4),
      sentence(2, [], 0.8231),
      sentence(3, [], null),
      sentence(4, [], 0.4),
      sentence(5, [], 0.8239), // same "0.82" label as s2 — the raw number still decides
    ];

    expect(sortByRelevance(list).map((s) => s.sid)).toEqual(['s5', 's2', 's1', 's4', 's0', 's3']);
    expect(list.map((s) => s.sid)).toEqual(['s0', 's1', 's2', 's3', 's4', 's5']); // input untouched
  });

  it('keeps document order when nothing is scored, and handles an empty list', () => {
    const list = [sentence(2), sentence(0), sentence(1)];
    expect(sortByRelevance(list).map((s) => s.sid)).toEqual(['s0', 's1', 's2']);
    expect(sortByRelevance([])).toEqual([]);
  });

  it('knows whether any sentence is scored', () => {
    expect(hasScores(SENTENCES)).toBe(true);
    expect(hasScores([sentence(0), sentence(1, [], 0)])).toBe(true);
    expect(hasScores([sentence(0), sentence(1)])).toBe(false);
    expect(hasScores([])).toBe(false);
  });

  it('captions a row with its last heading, or "Intro" before the first heading', () => {
    expect(sectionOf(sentence(0, ['Part one', 'Detail']))).toBe('Detail');
    expect(sectionOf(sentence(0, []))).toBe('Intro');
  });
});
