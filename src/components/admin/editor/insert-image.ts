// Pure pieces of the editor's Image button (spec/ui.md §4 Editor → Image; capability
// media-images): the Markdown snippet (shared with the upload route), cursor insertion with
// blank-line padding, the alt text pre-filled from the filename, and the client-side type allowlist.

import { imageMarkdown } from '@/lib/media/image-markdown';

export const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export const ACCEPTED_IMAGE_EXT: Record<string, (typeof ACCEPTED_IMAGE_TYPES)[number]> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};
export const IMAGES_ONLY_NOTICE = 'Images only — PNG, JPEG, WebP or GIF';
export const ALT_MAX = 200;
export const CAPTION_MAX = 200;

/** The upload route's snippet (`![alt](url)` / `![alt](url "caption")`, escaped, single-line), built
 *  client-side when a response carries no `markdown`. */
export function imageSnippet(alt: string, url: string, caption?: string | null): string {
  return imageMarkdown(alt, url, caption ?? undefined);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Number.isFinite(n) ? Math.trunc(n) : lo));
}

/**
 * Replaces `[start, end)` of `value` with `snippet` on its own line: a blank line is added before
 * and after only when the neighbouring text is not already blank (or the document edge).
 * Returns the new text and the caret position just after the snippet.
 */
export function insertAtCursor(value: string, start: number, end: number, snippet: string): { value: string; caret: number } {
  const s = clamp(start, 0, value.length);
  const e = clamp(end, s, value.length);
  const before = value.slice(0, s);
  const after = value.slice(e);

  let pad = '';
  if (before !== '') {
    if (!before.endsWith('\n')) pad = '\n\n';
    else if (!before.endsWith('\n\n')) pad = '\n';
  }
  // Collapse extra blank lines the writer already left before the caret.
  const lead = before.replace(/\n{3,}$/, '\n\n') + pad;

  let tail = '';
  if (after !== '') {
    if (!after.startsWith('\n')) tail = '\n\n';
    else if (!after.startsWith('\n\n')) tail = '\n';
  }
  const trail = tail + after.replace(/^\n{3,}/, '\n\n');

  const next = lead + snippet + trail;
  return { value: next, caret: lead.length + snippet.length };
}

/** Filename without its extension, `-`/`_` → spaces, trimmed, ≤ 200 chars. */
export function altFromFilename(name: string): string {
  const base = name.replace(/^.*[\\/]/, '');
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : dot === 0 ? '' : base;
  return stem.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, ALT_MAX);
}

/** Client-side allowlist (the server decides by bytes; this only filters obvious non-images early). */
export function isAcceptedImage(file: { type: string; name: string }): boolean {
  if (file.type) return (ACCEPTED_IMAGE_TYPES as readonly string[]).includes(file.type);
  const ext = file.name.toLowerCase().replace(/^.*\./, '');
  return ext in ACCEPTED_IMAGE_EXT;
}

/** A caret / selection in the Markdown text, as `[start, end)` offsets. */
export interface TextRange {
  start: number;
  end: number;
}

/**
 * Moves an offset of `prev` to the same place in `next` (spec/capabilities/media-images.md:
 * the snippet goes where the cursor was when the upload started, tracked through edits by offset
 * shift). The edit is the span between the common prefix and the common suffix: an offset before
 * it stays, one after it shifts by the length change, one inside it lands at the end of the
 * replacement (the start, for a pure deletion). An edit right at the offset counts as after it.
 */
export function shiftOffset(pos: number, prev: string, next: string): number {
  if (prev === next) return pos;
  const max = Math.min(prev.length, next.length);
  let p = 0;
  while (p < max && prev.charCodeAt(p) === next.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && prev.charCodeAt(prev.length - 1 - s) === next.charCodeAt(next.length - 1 - s)) s++;
  const at = clamp(pos, 0, prev.length);
  if (at <= p) return at;
  if (at >= prev.length - s) return at + (next.length - prev.length);
  return next.length - s;
}

/** `shiftOffset` for both ends of a range (end never before start). */
export function shiftRange(range: TextRange, prev: string, next: string): TextRange {
  const start = shiftOffset(range.start, prev, next);
  const end = Math.max(start, shiftOffset(range.end, prev, next));
  return { start, end };
}
