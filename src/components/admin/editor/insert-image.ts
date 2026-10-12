// Pure pieces of the editor's Image button (spec/ui.md §4 Editor → Image; capability
// media-images): the Markdown snippet, cursor insertion with blank-line padding, the alt text
// pre-filled from the filename, and the client-side type allowlist.

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

/** `![alt](url)` or `![alt](url "caption")` — `"` in the caption escaped as `\"`, `[`/`]` in the alt escaped. */
export function imageSnippet(alt: string, url: string, caption?: string | null): string {
  const safeAlt = alt.replace(/[[\]]/g, '\\$&');
  const cap = caption?.trim() ?? '';
  if (cap !== '') return `![${safeAlt}](${url} "${cap.replace(/"/g, '\\"')}")`;
  return `![${safeAlt}](${url})`;
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
