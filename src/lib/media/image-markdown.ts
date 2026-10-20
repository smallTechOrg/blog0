// The Markdown snippet for an uploaded image (spec/api.md → POST /api/admin/uploads/images). Pure +
// isomorphic: the upload route answers with it; the editor's insert-image helper can build the same.

/** Line breaks (and other control characters) would end the snippet early: collapse them to one space. */
function oneLine(text: string): string {
  return text.replace(/[\r\n\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/ {2,}/g, ' ').trim();
}

/**
 * `![alt](/media/<key>)` or `![alt](/media/<key> "caption")`. Alt and caption are single-line;
 * `\`, `[` and `]` in the alt and `\` and `"` in the caption are backslash-escaped so the snippet
 * parses back to exactly the text the writer typed.
 */
export function imageMarkdown(alt: string, url: string, caption?: string): string {
  const safeAlt = oneLine(alt).replace(/[\\[\]]/g, '\\$&');
  const title = caption === undefined ? '' : oneLine(caption);
  if (title !== '') return `![${safeAlt}](${url} "${title.replace(/[\\"]/g, '\\$&')}")`;
  return `![${safeAlt}](${url})`;
}
