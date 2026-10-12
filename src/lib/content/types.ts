// Content pipeline contract (spec/architecture.md §4). Pure + isomorphic: produced by
// src/server/content (S1.2), consumed by Jev, the format adapters and the reader components.

export type Block =
  | { kind: 'html'; html: string }
  | { kind: 'figure'; figureId: string; known: boolean };
export interface Paragraph { pid: string; index: number; text: string; kind: 'p' | 'li' | 'quote'; headingPath: string[] }
export interface Sentence { sid: string; index: number; pid: string; text: string; words: number }
export interface RenderWarning { code: 'UNKNOWN_FIGURE' | 'RAW_HTML_DROPPED' | 'EMPTY_BODY' | 'UNKNOWN_CODE_LANG'; message: string; line?: number }
export interface RenderedArticle {
  blocks: Block[]; paragraphs: Paragraph[]; sentences: Sentence[];   // sentences = eligible only, index 0..N-1
  stats: { words: number; readMinutes: number };
  fingerprints: { body: string; paragraphs: string; sentences: string };
  warnings: RenderWarning[];
}

/** Figure ids the reader can render (`@@fig:<id>@@` on its own line). */
export const KNOWN_FIGURES = ['slide47', 'ab-companies'] as const;
export type KnownFigureId = (typeof KNOWN_FIGURES)[number];

export function isKnownFigure(id: string): id is KnownFigureId {
  return (KNOWN_FIGURES as readonly string[]).includes(id);
}

/** Input to renderArticle(). */
export interface RenderInput { title: string; dek: string; bodyMd: string }
