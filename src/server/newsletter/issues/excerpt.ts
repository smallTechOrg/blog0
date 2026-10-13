// The issue excerpt (spec/architecture.md §13.4; capability newsletter-issues.md "Assumed"): the
// published body's first paragraph, first 60 words, with an ellipsis when cut. Pure, no I/O.

export const EXCERPT_WORDS = 60;

export interface ExcerptParagraph {
  text: string;
  kind: 'p' | 'li' | 'quote';
}

/**
 * The first prose paragraph (`kind: 'p'`; a body that opens with a list or quote falls back to the
 * first paragraph of any kind), cut to `maxWords` words + `…`. An empty body → `''` (the issue then
 * shows the dek only).
 */
export function excerptFrom(paragraphs: readonly ExcerptParagraph[], maxWords: number = EXCERPT_WORDS): string {
  const first = paragraphs.find((p) => p.kind === 'p' && p.text.trim() !== '') ?? paragraphs.find((p) => p.text.trim() !== '');
  if (!first) return '';
  const words = first.text.trim().split(/\s+/);
  if (words.length <= maxWords) return words.join(' ');
  const cut = words.slice(0, maxWords).join(' ').replace(/[\s,;:.!?…—–-]+$/u, '');
  return `${cut}…`;
}
