import 'server-only';

import { isElement, isWhitespaceText, walk, type HElement, type HNode, type HRoot } from '../ast';

// Images (design-app.js mdToHtml / mdInline):
// - an image alone in a paragraph → <figure class="mdfig"><img loading="lazy" alt><figcaption>title</figcaption></figure>
// - any other image → <img class="mdimg" loading="lazy"> (+ <span class="mdimg__cap"> when titled)

function imgElement(src: HElement): HElement {
  const { src: url, alt } = src.properties;
  return {
    type: 'element',
    tagName: 'img',
    properties: { src: url, alt: typeof alt === 'string' ? alt : '', loading: 'lazy' },
    children: [],
  };
}

function caption(img: HElement): string | null {
  const title = img.properties.title;
  return typeof title === 'string' && title.trim() ? title : null;
}

export function images(root: HRoot): void {
  walk<HNode>(root, (node, index, parent) => {
    if (isElement(node, 'p')) {
      const content = node.children.filter((c) => !isWhitespaceText(c));
      const only = content.length === 1 ? content[0] : null;
      if (only && isElement(only, 'img')) {
        const cap = caption(only);
        const figure: HElement = {
          type: 'element',
          tagName: 'figure',
          properties: { className: ['mdfig'] },
          children: [
            imgElement(only),
            ...(cap ? [{ type: 'element', tagName: 'figcaption', properties: {}, children: [{ type: 'text', value: cap }] }] : []),
          ],
        };
        parent.children![index] = figure;
        return;
      }
    }
    if (!isElement(node, 'img')) return;
    // Inline image (figure images were rebuilt above and are skipped here by class).
    if (isElement(parent, 'figure')) return;
    const cap = caption(node);
    const img = imgElement(node);
    img.properties.className = ['mdimg'];
    parent.children![index] = img;
    if (cap) {
      parent.children!.splice(index + 1, 0, {
        type: 'element',
        tagName: 'span',
        properties: { className: ['mdimg__cap'] },
        children: [{ type: 'text', value: cap }],
      });
    }
  });
}
