import { describe, expect, it } from 'vitest';

import {
  changedExcerpt,
  changedWords,
  completesSentence,
  cooldownLeft,
  MIN_INTERVAL_MS,
  reviewTrigger,
  SENTENCE_MIN_WORDS,
  WORDS_THRESHOLD,
} from '@/components/admin/editor/assistant-trigger';

// SMA-43: the assistant reads again after ~40 changed words or a finished sentence.

const words = (n: number, w = 'word') => Array.from({ length: n }, () => w).join(' ');

describe('changedWords', () => {
  it('counts the words in the one changed region (typing, pasting, deleting)', () => {
    expect(changedWords('', '')).toBe(0);
    expect(changedWords('One two three.', 'One two three. Four five six')).toBe(3);
    expect(changedWords('A ' + words(50), 'A')).toBe(50);
    expect(changedWords('alpha beta gamma', 'alpha BETA gamma')).toBe(1);
  });

  it('counts a fixed typo inside a word as one word, not zero', () => {
    expect(changedWords('the qiuck fox', 'the quick fox')).toBe(1);
  });
});

describe('completesSentence', () => {
  it('is true when the added text ends a sentence', () => {
    expect(completesSentence('It rained', 'It rained all day.')).toBe(true);
    expect(completesSentence('Why', 'Why not?')).toBe(true);
    expect(completesSentence('He said', 'He said "stop."')).toBe(true);
    expect(completesSentence('Para one.\n\n', 'Para one.\n\nA pasted paragraph that ends.')).toBe(true);
  });

  it('is false mid-sentence or for a pure deletion', () => {
    expect(completesSentence('It rained', 'It rained all')).toBe(false);
    expect(completesSentence('It rained all day.', 'It rained.')).toBe(false);
    expect(completesSentence('e.g', 'e.g. the')).toBe(false);
  });
});

describe('reviewTrigger', () => {
  it(`reads after about ${WORDS_THRESHOLD} changed words`, () => {
    expect(reviewTrigger('Start.', 'Start. ' + words(WORDS_THRESHOLD - 1))).toBeNull();
    expect(reviewTrigger('Start.', 'Start. ' + words(WORDS_THRESHOLD))).toBe('words');
  });

  it(`reads after a finished sentence of ${SENTENCE_MIN_WORDS}+ changed words, not after a full stop alone`, () => {
    const base = 'An opening line.';
    expect(reviewTrigger(base, `${base} ${words(SENTENCE_MIN_WORDS)}.`)).toBe('sentence');
    expect(reviewTrigger(base, `${base} ${words(SENTENCE_MIN_WORDS - 2)}.`)).toBeNull();
    expect(reviewTrigger('Draft', 'Draft.')).toBeNull();
  });

  it('never reads an empty or unchanged draft', () => {
    expect(reviewTrigger('', '   ')).toBeNull();
    expect(reviewTrigger('Same text here.', 'Same text here.')).toBeNull();
  });
});

describe('changedExcerpt', () => {
  it('widens the change to whole paragraphs', () => {
    const prev = 'First para.\n\nSecond para starts. It goes on.\n\nThird.';
    const next = 'First para.\n\nSecond para starts. It goes on and on.\n\nThird.';
    expect(changedExcerpt(prev, next)).toBe('Second para starts. It goes on and on.');
    expect(changedExcerpt('', 'Brand new.')).toBe('Brand new.');
    expect(changedExcerpt('Gone text.', '')).toBe('');
  });

  it('is capped at 8000 characters', () => {
    expect(changedExcerpt('', 'x'.repeat(9000))).toHaveLength(8000);
  });
});

describe('cooldownLeft', () => {
  it('waits out the minimum interval after a read started', () => {
    expect(cooldownLeft(null, 1000)).toBe(0);
    expect(cooldownLeft(1000, 1000 + MIN_INTERVAL_MS - 500)).toBe(500);
    expect(cooldownLeft(1000, 1000 + MIN_INTERVAL_MS + 1)).toBe(0);
  });
});
