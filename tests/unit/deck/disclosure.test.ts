import { describe, expect, it } from 'vitest';

import { DECK_DISCLOSURE, deckDisclosure } from '@/lib/view-models';

describe('deckDisclosure', () => {
  it('credits Jev alone when every line came from Jev', () => {
    expect(deckDisclosure(['jev', 'jev', 'jev'])).toBe('Lines selected by Jev (AI), verbatim from the article.');
  });

  it('credits Jev and the editors when the deck was hand-edited', () => {
    expect(deckDisclosure(['jev', 'writer'])).toBe(DECK_DISCLOSURE.mixed);
    expect(DECK_DISCLOSURE.mixed).toBe('Lines selected by Jev (AI) and the editors, verbatim from the article.');
  });

  it('credits only the editors when no line came from Jev, including an empty deck', () => {
    expect(deckDisclosure(['writer'])).toBe('Lines selected by the editors, verbatim from the article.');
    expect(deckDisclosure([])).toBe(DECK_DISCLOSURE.editors);
  });
});
