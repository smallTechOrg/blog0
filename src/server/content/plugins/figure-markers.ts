import 'server-only';

import { isKnownFigure, type RenderWarning } from '@/lib/content/types';

import type { MdRoot } from '../ast';

// A top-level paragraph whose entire trimmed text is `@@fig:<id>@@` becomes a `blog0Figure` node
// (rendered as a `<blog0-figure>` placeholder that render.ts turns into a figure Block).
// Unknown ids keep their node (known=false, renders nothing publicly) and raise UNKNOWN_FIGURE.

export const FIGURE_MARKER = /^@@fig:([a-z0-9-]+)@@$/;
export const FIGURE_TAG = 'blog0-figure';

export function figureMarkers(root: MdRoot, warnings: RenderWarning[]): void {
  root.children = root.children.map((node) => {
    if (node.type !== 'paragraph') return node;
    const kids = node.children ?? [];
    if (!kids.length || !kids.every((k) => k.type === 'text')) return node;
    const match = FIGURE_MARKER.exec(kids.map((k) => k.value ?? '').join('').trim());
    if (!match) return node;

    const figureId = match[1];
    const known = isKnownFigure(figureId);
    if (!known) {
      warnings.push({
        code: 'UNKNOWN_FIGURE',
        message: `Unknown figure "${figureId}" — it will not render on the public page.`,
        line: node.position?.start.line,
      });
    }
    return {
      type: 'blog0Figure',
      figureId,
      known,
      position: node.position,
      data: { hName: FIGURE_TAG, hProperties: { dataFigureId: figureId } },
    };
  });
}
