import 'server-only';

import type { Paragraph, RenderedArticle } from '@/lib/content/types';

export const WORDS_PER_MINUTE = 230;

/** Whitespace-separated word count (the design's rule; also used for sentence eligibility). */
export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/** words = all paragraph plain text; readMinutes = max(1, ceil(words / 230)). */
export function computeStats(paragraphs: readonly Paragraph[]): RenderedArticle['stats'] {
  const words = paragraphs.reduce((sum, p) => sum + countWords(p.text), 0);
  return { words, readMinutes: Math.max(1, Math.ceil(words / WORDS_PER_MINUTE)) };
}
