import 'server-only';

import type { RenderWarning } from '@/lib/content/types';

import { walk, type MdNode, type MdRoot } from '../ast';

// An image whose address is a `data:` URL (what Google Docs / Notion export when they inline a
// picture) is never shown: URL sanitisation removes it. Report each one so the preview tells the
// writer why the picture is missing and what to do. The editor normally uploads pasted data
// images before they get here (spec/capabilities/media-images.md → "Pasted Markdown").

type RefNode = MdNode & { identifier?: string };

const isData = (url: unknown): boolean => typeof url === 'string' && /^data:/i.test(url.replace(/[\u0000- ]/g, ''));

export function checkEmbeddedImages(root: MdRoot, warnings: RenderWarning[]): void {
  const definitions = new Map<string, string>();
  walk<MdNode>(root, (node) => {
    const n = node as RefNode;
    if (n.type === 'definition' && n.identifier && typeof n.url === 'string' && !definitions.has(n.identifier)) definitions.set(n.identifier, n.url);
  });
  walk<MdNode>(root, (node) => {
    const n = node as RefNode;
    const url = n.type === 'image' ? n.url : n.type === 'imageReference' && n.identifier ? definitions.get(n.identifier) : undefined;
    if (!isData(url)) return;
    const line = n.position?.start.line;
    warnings.push({
      code: 'EMBEDDED_IMAGE_DROPPED',
      message: `An image embedded in the text is not shown${line ? ` (line ${line})` : ''}. Paste the Markdown into the editor so its images are uploaded, or add the image with the Image button.`,
      line,
    });
  });
}
