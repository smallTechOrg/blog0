import { describe, expect, it } from 'vitest';

import type { Paragraph } from '@/lib/content/types';
import { ABBREVIATIONS, buildSentences, MIN_ELIGIBLE_WORDS, splitSentences } from '@/server/content';

function para(pid: string, text: string): Paragraph {
  return { pid, index: 0, text, kind: 'p', headingPath: [] };
}

describe('splitSentences', () => {
  it('splits on full stops, question marks and exclamation marks', () => {
    const text = 'Can a machine tell? It can, if we are careful! Then we move on.';

    expect(splitSentences(text)).toEqual(['Can a machine tell?', 'It can, if we are careful!', 'Then we move on.']);
  });

  it.each(ABBREVIATIONS.map((a) => [a]))('does not end a sentence after the abbreviation %s', (abbr) => {
    const text = `We met the person ${abbr} Someone Else said hello to the room. Next sentence here.`;

    const out = splitSentences(text);

    expect(out).toEqual([`We met the person ${abbr} Someone Else said hello to the room.`, 'Next sentence here.']);
  });

  it('keeps decimals, URLs with dots and inline code together', () => {
    const text = 'Growth hit 3.5% at docs.example.co.uk/guide.v2.html today. Call a.b() later on.';

    expect(splitSentences(text)).toEqual(['Growth hit 3.5% at docs.example.co.uk/guide.v2.html today.', 'Call a.b() later on.']);
  });

  it('keeps initials with the name that follows', () => {
    expect(splitSentences('The book by J. R. R. Tolkien is long. It is good.')).toEqual([
      'The book by J. R. R. Tolkien is long.',
      'It is good.',
    ]);
  });

  it('ends a sentence after a closing curly quote', () => {
    const text = 'She said, “The splitter must respect quotes.” Then the meeting moved on.';

    expect(splitSentences(text)).toEqual(['She said, “The splitter must respect quotes.”', 'Then the meeting moved on.']);
  });

  it('only merges abbreviations at a word start (a word ending in "no." is not "No.")', () => {
    expect(splitSentences('I said Kono. Then we left the place.')).toEqual(['I said Kono.', 'Then we left the place.']);
  });

  it('returns an empty list for empty or whitespace-only text', () => {
    expect(splitSentences('')).toEqual([]);
    expect(splitSentences('   ')).toEqual([]);
  });

  it('returns trimmed exact substrings of the input, in order', () => {
    const text = 'Dr. Rao met the U.S. team.   Then, e.g. at noon, they ate!  Done? Yes 🎉 truly.';

    const out = splitSentences(text);

    let cursor = 0;
    for (const s of out) {
      const at = text.indexOf(s, cursor);
      expect(at).toBeGreaterThanOrEqual(cursor);
      expect(s).toBe(s.trim());
      cursor = at + s.length;
    }
    expect(out.join(' ').replace(/\s+/g, ' ')).toBe(text.replace(/\s+/g, ' '));
  });

  it('is deterministic across repeated runs', () => {
    const text = 'Dr. Rao met the U.S. team. Then, e.g. at noon, they ate! Done? Yes.';

    const runs = Array.from({ length: 5 }, () => splitSentences(text));

    for (const run of runs) expect(run).toEqual(runs[0]);
  });
});

describe('buildSentences', () => {
  it('numbers sids per paragraph over all sentences and indexes only eligible ones', () => {
    const paragraphs = [
      para('p-aaaaaaaa', 'Too short here. This sentence has more than five words in it.'),
      para('p-bbbbbbbb', 'Another paragraph with a long enough sentence. Tiny.'),
    ];

    const out = buildSentences(paragraphs);

    expect(out).toEqual([
      { sid: 'p-aaaaaaaa-s1', index: 0, pid: 'p-aaaaaaaa', text: 'This sentence has more than five words in it.', words: 9 },
      { sid: 'p-bbbbbbbb-s0', index: 1, pid: 'p-bbbbbbbb', text: 'Another paragraph with a long enough sentence.', words: 7 },
    ]);
  });

  it(`treats exactly ${MIN_ELIGIBLE_WORDS} words as eligible and 4 as not`, () => {
    const out = buildSentences([para('p-cccccccc', 'One two three four five. One two three four.')]);

    expect(out.map((s) => s.text)).toEqual(['One two three four five.']);
  });

  it('yields nothing for paragraphs without eligible sentences', () => {
    expect(buildSentences([para('p-dddddddd', 'Only three words.')])).toEqual([]);
    expect(buildSentences([])).toEqual([]);
  });
});
