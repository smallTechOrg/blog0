// Content pipeline contract (spec/architecture.md §4). Pure + isomorphic: produced by
// src/server/content, consumed by the TLDR AI ranking, the format adapters and the reader components.

export type Block = { kind: 'html'; html: string };
export interface Paragraph { pid: string; index: number; text: string; kind: 'p' | 'li' | 'quote'; headingPath: string[] }
export interface Sentence { sid: string; index: number; pid: string; text: string; words: number }
export interface RenderWarning { code: 'RAW_HTML_DROPPED' | 'EMBEDDED_IMAGE_DROPPED' | 'EMPTY_BODY' | 'UNKNOWN_CODE_LANG'; message: string; line?: number }
export interface RenderedArticle {
  blocks: Block[]; paragraphs: Paragraph[]; sentences: Sentence[];   // sentences = eligible only (AI-ranked), index 0..N-1
  /** Every sentence of the article, any length, index 0..M-1 (SMA-35: the deck hand-picker and deck
   *  validation use these, so a writer can pick short lines the AI never sees). Same sids as `sentences`. */
  lines: Sentence[];
  stats: { words: number; readMinutes: number };
  fingerprints: { body: string; paragraphs: string; sentences: string };
  warnings: RenderWarning[];
}

/** Input to renderArticle(). */
export interface RenderInput {
  title: string;
  dek: string;
  bodyMd: string;
  /** Stage A: width/height per image src as written (`/media/<key>`), looked up before the render
   *  (src/server/public/image-dims.ts). Only the published page passes it. */
  imageDims?: ReadonlyMap<string, { width: number; height: number }>;
}
