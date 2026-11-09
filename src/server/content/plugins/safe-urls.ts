import 'server-only';

import { isElement, isWhitespaceText, walk, type HNode, type HRoot } from '../ast';

// URL sanitisation. Markdown links/images pass their URL straight through to hast, so a
// `javascript:` / `data:` / `vbscript:` URL would otherwise reach the page. Allowed: relative
// URLs, fragments, http, https, mailto, tel. A disallowed link keeps its text without an href;
// a disallowed image is removed.

const SAFE_PROTOCOLS = new Set(['http', 'https', 'mailto', 'tel']);

export function isSafeUrl(url: string): boolean {
  // Browsers ignore ASCII control chars and whitespace inside a scheme ("java\tscript:").
  const compact = url.replace(/[\u0000- \u007f]/g, '');
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(compact);
  if (!scheme) return true;
  return SAFE_PROTOCOLS.has(scheme[1].toLowerCase());
}

export function safeUrls(root: HRoot): void {
  walk<HNode>(root, (node, index, parent) => {
    if (isElement(node, 'a')) {
      const href = node.properties.href;
      if (typeof href === 'string' && !isSafeUrl(href)) {
        delete node.properties.href;
        delete node.properties.target;
        delete node.properties.rel;
      }
      return;
    }
    if (isElement(node, 'img')) {
      const src = node.properties.src;
      if (typeof src !== 'string' || !isSafeUrl(src)) parent.children!.splice(index, 1, { type: 'text', value: '' });
    }
  });
  // A paragraph that held only a removed image would render as an empty <p></p>.
  const prune = (node: HNode): void => {
    if (!node.children) return;
    node.children = node.children.filter(
      (c) => !(isElement(c, 'p') && !Object.keys(c.properties).length && c.children.every(isWhitespaceText)),
    );
    node.children.forEach(prune);
  };
  prune(root);
}
