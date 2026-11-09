import { describe, expect, it } from 'vitest';

import {
  TDECK_STEP_MS,
  TDECK_SWIPE,
  TDECK_WHEEL,
  buildDeckSlides,
  tdeckSlide,
  tldrDwell,
  tldrMinutes,
  tldrType,
  tldrWords,
} from '@/lib/deck/timing';

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

describe('deck constants', () => {
  it('keeps the design timings verbatim', () => {
    expect(TDECK_STEP_MS).toBe(720);
    expect(TDECK_WHEEL).toBe(90);
    expect(TDECK_SWIPE).toBe(56);
  });
});

describe('tldrWords', () => {
  it('counts whitespace-separated words of a slide', () => {
    expect(tldrWords({ text: '  one two\nthree   four ' })).toBe(4);
  });

  it('counts an empty slide as one word, exactly like the design formula', () => {
    expect(tldrWords({ text: '' })).toBe(1);
  });
});

describe('tldrDwell', () => {
  it('holds the intro title card for a fixed 3.8 s beat', () => {
    expect(tldrDwell({ kind: 'intro', text: words(40) })).toBe(3800);
  });

  it('scales a line slide with its word count', () => {
    // 1100 + (10 / 3.1) * 1000 = 4325.8…
    expect(tldrDwell({ text: words(10) })).toBe(4326);
  });

  it('floors a short line at 2.8 s and caps a long one at 9 s', () => {
    expect(tldrDwell({ text: words(1) })).toBe(2800);
    expect(tldrDwell({ text: words(80) })).toBe(9000);
  });
});

describe('tldrType', () => {
  it('lands a six-word line at the 58 px ceiling', () => {
    expect(tldrType({ text: words(6) })).toBe('clamp(26px, 8.06vw, 58px)');
  });

  it('shrinks a long line to the 23 px floor with a 17 px minimum', () => {
    expect(tldrType({ text: words(50) })).toBe('clamp(17px, 3.19vw, 23px)');
  });

  it('interpolates between the bounds', () => {
    // px = round(60 - (20 - 6) * 0.85) = round(48.1) = 48; min = round(21.12) = 21; 48 / 7.2 = 6.67
    expect(tldrType({ text: words(20) })).toBe('clamp(21px, 6.67vw, 48px)');
  });
});

describe('buildDeckSlides', () => {
  it('opens with the intro title card and keeps one slide per line in order', () => {
    const slides = buildDeckSlides('The title', 'The dek', ['First line here.', 'Second line here.']);

    expect(slides).toEqual([
      { kind: 'intro', text: 'The title', sub: 'The dek' },
      { kind: 'line', text: 'First line here.' },
      { kind: 'line', text: 'Second line here.' },
    ]);
  });

  it('drops an empty dek from the intro card', () => {
    expect(buildDeckSlides('T', '', [])[0]).toEqual({ kind: 'intro', text: 'T' });
  });
});

describe('tldrMinutes', () => {
  it('counts the title card and every line at 180 words a minute, rounded', () => {
    const slides = buildDeckSlides(words(10), 'ignored dek words', [words(200), words(150)]);

    // (10 + 200 + 150) / 180 = 2
    expect(tldrMinutes(slides)).toBe(2);
  });

  it('never reports less than one minute, even for an empty deck', () => {
    expect(tldrMinutes([])).toBe(1);
    expect(tldrMinutes(buildDeckSlides('Short', '', ['Tiny line.']))).toBe(1);
  });
});

describe('tdeckSlide', () => {
  it('normalises a plain string into a slide object', () => {
    expect(tdeckSlide('A line')).toEqual({ text: 'A line' });
    const obj = { text: 'x', img: '/a.png' };
    expect(tdeckSlide(obj)).toBe(obj);
  });
});
