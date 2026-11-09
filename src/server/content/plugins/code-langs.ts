import 'server-only';

import type { RenderWarning } from '@/lib/content/types';

import { walk, type MdNode, type MdRoot } from '../ast';
import { isSupportedCodeLang, PLAIN_LANG } from '../highlight';

// Fenced code languages: lower-cased; a language Shiki has not preloaded renders as plain text
// and raises UNKNOWN_CODE_LANG. Call after `await getHighlighter()`.

export function checkCodeLangs(root: MdRoot, warnings: RenderWarning[]): void {
  walk<MdNode>(root, (node) => {
    if (node.type !== 'code' || !node.lang) return;
    const lang = node.lang.toLowerCase();
    if (isSupportedCodeLang(lang)) {
      node.lang = lang;
      return;
    }
    warnings.push({
      code: 'UNKNOWN_CODE_LANG',
      message: `Code language "${node.lang}" is not supported; the block renders as plain text.`,
      line: node.position?.start.line,
    });
    node.lang = PLAIN_LANG;
  });
}
