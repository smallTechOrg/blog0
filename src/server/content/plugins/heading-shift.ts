import 'server-only';

import { walk, type MdNode, type MdRoot } from '../ast';

// Design rule (design-app.js mdToHtml): the article title is the h1, so the shallowest heading
// level the author used becomes h2 and the rest nest under it, capped at h4.

export const MIN_HEADING_DEPTH = 2;
export const MAX_HEADING_DEPTH = 4;

export function headingShift(root: MdRoot): void {
  const headings: MdNode[] = [];
  walk<MdNode>(root, (node) => {
    if (node.type === 'heading') headings.push(node);
  });
  if (!headings.length) return;

  const top = Math.min(...headings.map((h) => h.depth ?? 1));
  const shift = MIN_HEADING_DEPTH - top;
  for (const heading of headings) {
    heading.depth = Math.min(Math.max((heading.depth ?? 1) + shift, MIN_HEADING_DEPTH), MAX_HEADING_DEPTH);
  }
}
