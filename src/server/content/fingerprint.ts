import 'server-only';

import { createHash } from 'node:crypto';

import type { Paragraph, RenderInput, RenderedArticle, Sentence } from '@/lib/content/types';

// Fingerprints (spec/architecture.md §4). TLDR staleness compares `sentences`; Listen staleness
// compares `paragraphs`; `body` detects any content change of title/dek/body.

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** NFC, collapse every whitespace run to one space, trim. Used for paragraph ids and title/dek. */
export function normalizeText(value: string): string {
  return value.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/**
 * Markdown body normalisation for the body fingerprint: NFC, CRLF/CR → LF, trailing whitespace
 * per line and at the end removed. Whitespace is NOT collapsed — newlines are Markdown structure
 * (`- a\n- b` and `- a - b` are different documents).
 */
export function normalizeMarkdown(value: string): string {
  return value
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

export function computeFingerprints(
  input: RenderInput,
  paragraphs: readonly Paragraph[],
  sentences: readonly Sentence[],
): RenderedArticle['fingerprints'] {
  return {
    body: sha256Hex(
      [normalizeText(input.title), normalizeText(input.dek), normalizeMarkdown(input.bodyMd)].join('\u0000'),
    ),
    paragraphs: sha256Hex(paragraphs.map((p) => `${p.pid}\u0000${p.text}`).join('\n')),
    sentences: sha256Hex(sentences.map((s) => `${s.sid}\u0000${s.text}`).join('\n')),
  };
}
