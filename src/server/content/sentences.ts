import 'server-only';

import type { Paragraph, Sentence } from '@/lib/content/types';

import { countWords } from './stats';

// Sentence split (spec/architecture.md §4, consumed by Jev and the deck hand-picker).
// ICU sentence segmentation (Node 22's bundled ICU — Node is pinned) + an abbreviation merge.
// Every sentence is a verbatim substring of its paragraph's plain text.

export const ABBREVIATIONS = [
  'e.g.', 'i.e.', 'etc.', 'vs.', 'Mr.', 'Mrs.', 'Ms.', 'Dr.', 'Prof.', 'St.', 'No.', 'Fig.',
  'U.S.', 'U.K.', 'approx.', 'cf.', 'al.',
] as const;

/** A sentence is eligible (Jev input, hand-picker, deck) when it has at least this many words. */
export const MIN_ELIGIBLE_WORDS = 5;

const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });

/** Characters that may precede an abbreviation / initial (start of a word). */
const WORD_START = /[\s([{“‘"'«—–-]/;

function endsWithAbbreviation(segment: string): boolean {
  for (const abbr of ABBREVIATIONS) {
    if (!segment.endsWith(abbr)) continue;
    const before = segment.length - abbr.length - 1;
    if (before < 0 || WORD_START.test(segment[before])) return true;
  }
  // A single capital letter + "." (initials such as "J. R. R. Tolkien").
  return /(?:^|[^A-Za-z])[A-Z]\.$/.test(segment);
}

/**
 * Splits plain text into sentences. Each result is trimmed and is an exact substring of `text`.
 * Deterministic for a given Node/ICU version.
 */
export function splitSentences(text: string): string[] {
  const spans: Array<{ start: number; end: number }> = [];
  for (const { segment, index } of segmenter.segment(text)) {
    const lead = segment.length - segment.trimStart().length;
    const core = segment.trim();
    if (!core) continue;
    spans.push({ start: index + lead, end: index + lead + core.length });
  }

  const merged: Array<{ start: number; end: number }> = [];
  let open: { start: number; end: number } | null = null;
  for (const span of spans) {
    open = open ? { start: open.start, end: span.end } : span;
    if (!endsWithAbbreviation(text.slice(open.start, open.end))) {
      merged.push(open);
      open = null;
    }
  }
  if (open) merged.push(open);

  return merged.map((s) => text.slice(s.start, s.end));
}

/**
 * Sentences of every paragraph, `sid = pid + '-s' + k` (k counts all sentences of the paragraph),
 * filtered to eligible ones; `index` is the position among eligible sentences (0..N-1).
 */
export function buildSentences(paragraphs: readonly Paragraph[]): Sentence[] {
  const out: Sentence[] = [];
  for (const paragraph of paragraphs) {
    splitSentences(paragraph.text).forEach((text, k) => {
      const words = countWords(text);
      if (words < MIN_ELIGIBLE_WORDS) return;
      out.push({ sid: `${paragraph.pid}-s${k}`, index: out.length, pid: paragraph.pid, text, words });
    });
  }
  return out;
}
