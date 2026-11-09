import 'server-only';

import type { RenderWarning } from '@/lib/content/types';

import type { MdNode, MdRoot } from '../ast';

// Raw HTML is never rendered (spec/capabilities/article-authoring.md). Every `html` node (block or
// inline, comments included) is removed from the tree and reported as RAW_HTML_DROPPED.
// remark-rehype also runs without `allowDangerousHtml` as a second line of defence.

export function dropRawHtml(root: MdRoot, warnings: RenderWarning[]): void {
  const prune = (node: MdNode): void => {
    if (!node.children) return;
    node.children = node.children.filter((child) => {
      if (child.type !== 'html') return true;
      const line = child.position?.start.line;
      warnings.push({
        code: 'RAW_HTML_DROPPED',
        message: `Raw HTML is not rendered${line ? ` (line ${line})` : ''}; use Markdown instead.`,
        line,
      });
      return false;
    });
    node.children.forEach(prune);
  };
  prune(root);
}
