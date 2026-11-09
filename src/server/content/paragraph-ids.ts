import 'server-only';

import type { Paragraph } from '@/lib/content/types';

import { SKIP, walk, type MdNode, type MdRoot } from './ast';
import { normalizeText, sha256Hex } from './fingerprint';

// Stable paragraph bookmarks (spec/architecture.md §4). The id depends only on the paragraph's
// own text, so editing one paragraph never moves another's id. Duplicates get -2, -3 … in
// document order.

/** Plain text of an mdast phrasing tree: text + inlineCode; images, footnote refs and raw HTML
 * contribute nothing; `break` → space; whitespace collapsed; trimmed. */
export function plainText(node: MdNode): string {
  const parts: string[] = [];
  const collect = (n: MdNode): void => {
    switch (n.type) {
      case 'text':
      case 'inlineCode':
        parts.push(n.value ?? '');
        return;
      case 'break':
        parts.push(' ');
        return;
      case 'image':
      case 'imageReference':
      case 'footnoteReference':
      case 'html':
        return;
      default:
        for (const child of n.children ?? []) collect(child);
    }
  };
  collect(node);
  return parts.join('').replace(/\s+/g, ' ').trim();
}

/** `'p-' + sha256(normalize(text)).slice(0, 8)` */
export function paragraphHash(text: string): string {
  return `p-${sha256Hex(normalizeText(text)).slice(0, 8)}`;
}

/** mdast-util-to-hast's rule: a list is loose when it or any item is spread. */
function listIsLoose(list: MdNode): boolean {
  if (list.spread) return true;
  return (list.children ?? []).some((item) =>
    item.spread === null || item.spread === undefined ? (item.children?.length ?? 0) > 1 : item.spread,
  );
}

function setBookmark(target: MdNode, pid: string): void {
  const className = ['para'];
  // to-hast sets `task-list-item` on checked items; hProperties would overwrite it.
  if (target.type === 'listItem' && typeof target.checked === 'boolean') className.push('task-list-item');
  target.data = { ...target.data, hProperties: { ...target.data?.hProperties, id: pid, dataPid: pid, className } };
}

/**
 * Assigns pids to every paragraph (top level, in list items, in blockquotes; not in tables or
 * footnote definitions) and attaches `id` + `data-pid` + class `para` to the rendered `<p>` — or
 * to the `<li>` when the paragraph sits in a tight list item (to-hast unwraps it there).
 * Paragraphs with no plain text (e.g. an image alone) get no id. Also records each paragraph's
 * heading path (texts of the enclosing headings, after heading shift).
 */
export function assignParagraphIds(root: MdRoot): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  const seen = new Map<string, number>();
  const headings: Array<{ depth: number; text: string }> = [];
  const bookmarked = new Set<MdNode>();

  walk<MdNode>(root, (node, _index, parent, ancestors) => {
    if (node.type === 'footnoteDefinition' || node.type === 'table' || node.type === 'code') return SKIP;
    if (node.type === 'heading') {
      const depth = node.depth ?? 2;
      while (headings.length && headings[headings.length - 1].depth >= depth) headings.pop();
      headings.push({ depth, text: plainText(node) });
      return SKIP;
    }
    if (node.type !== 'paragraph') return;

    const text = plainText(node);
    if (!text) return SKIP;

    const base = paragraphHash(text);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const pid = n === 1 ? base : `${base}-${n}`;

    let kind: Paragraph['kind'] = 'p';
    for (let i = ancestors.length - 1; i >= 0; i--) {
      if (ancestors[i].type === 'listItem') { kind = 'li'; break; }
      if (ancestors[i].type === 'blockquote') { kind = 'quote'; break; }
    }

    const list = ancestors[ancestors.length - 2];
    const tight = parent.type === 'listItem' && list?.type === 'list' && !listIsLoose(list);
    if (tight) {
      // One bookmark per <li>; a second unwrapped paragraph (not producible by CommonMark in a
      // tight item) keeps its pid in the data but has no element to carry it.
      if (!bookmarked.has(parent)) { setBookmark(parent, pid); bookmarked.add(parent); }
    } else {
      setBookmark(node, pid);
    }

    paragraphs.push({ pid, index: paragraphs.length, text, kind, headingPath: headings.map((h) => h.text) });
    return SKIP;
  });

  return paragraphs;
}
