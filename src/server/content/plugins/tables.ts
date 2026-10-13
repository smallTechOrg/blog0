import 'server-only';

import { isElement, SKIP, walk, type HNode, type HRoot } from '../ast';

// GFM tables scroll horizontally inside `.prose .table-scroll` (spec/ui.md → CSS additions).

export function wrapTables(root: HRoot): void {
  walk<HNode>(root, (node, index, parent) => {
    if (!isElement(node, 'table')) return;
    parent.children![index] = {
      type: 'element',
      tagName: 'div',
      properties: { className: ['table-scroll'] },
      children: [node],
    };
    return SKIP; // the wrapper holds the table; do not revisit it
  });
}
