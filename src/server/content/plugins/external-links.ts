import 'server-only';

import { addClass, isElement, walk, type HNode, type HRoot } from '../ast';

// Every link gets the design's `inline` class; absolute http(s) links open in a new tab
// (design: target=_blank rel="noopener noreferrer").

export function externalLinks(root: HRoot): void {
  walk<HNode>(root, (node) => {
    if (!isElement(node, 'a')) return;
    addClass(node, 'inline');
    const href = node.properties.href;
    if (typeof href === 'string' && /^https?:\/\//i.test(href)) {
      node.properties.target = '_blank';
      node.properties.rel = ['noopener', 'noreferrer'];
    }
  });
}
