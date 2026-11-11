// Links in the About texts (Admin → Site). Pure + isomorphic. The writer types `[label](https://…)`;
// only http(s) addresses become links, so nothing else (javascript:, data:, relative paths) can
// reach the page — anything that is not a well-formed http(s) link stays plain text.

export type InlinePart = { text: string; href?: string };

const LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;

/** `text` split into plain parts and link parts, in order (an empty text → no parts). */
export function parseInlineLinks(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  let at = 0;
  for (const m of text.matchAll(LINK)) {
    const start = m.index ?? 0;
    if (start > at) parts.push({ text: text.slice(at, start) });
    parts.push({ text: m[1], href: m[2] });
    at = start + m[0].length;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}

/** The text a reader sees, without the link syntax (for meta descriptions and the like). */
export function plainInline(text: string): string {
  return parseInlineLinks(text)
    .map((p) => p.text)
    .join('');
}
