import 'server-only';

import { isKnownFigure, type Block, type RenderedArticle, type RenderInput, type RenderWarning } from '@/lib/content/types';

import { isElement, isWhitespaceText, type HNode, type HRoot } from './ast';
import { computeFingerprints } from './fingerprint';
import { getHighlighter } from './highlight';
import { hastToHtml, mdastToHast, parseMarkdown } from './markdown';
import { assignParagraphIds } from './paragraph-ids';
import { checkCodeLangs } from './plugins/code-langs';
import { FIGURE_TAG, figureMarkers } from './plugins/figure-markers';
import { headingShift } from './plugins/heading-shift';
import { dropRawHtml } from './plugins/raw-html';
import { buildSentences } from './sentences';
import { computeStats } from './stats';

/** Bump on ANY change to the pipeline's output (keys the render cache). */
export const RENDER_VERSION = 'r1';

/** Splits the top-level hast children into html blocks at figure placeholders. */
function toBlocks(hast: HRoot): Block[] {
  const blocks: Block[] = [];
  let pending: HNode[] = [];
  const flush = (): void => {
    if (pending.some((n) => !isWhitespaceText(n))) blocks.push({ kind: 'html', html: hastToHtml(pending).trim() });
    pending = [];
  };
  for (const node of hast.children) {
    if (isElement(node, FIGURE_TAG)) {
      flush();
      const figureId = String(node.properties.dataFigureId ?? '');
      blocks.push({ kind: 'figure', figureId, known: isKnownFigure(figureId) });
    } else {
      pending.push(node);
    }
  }
  flush();
  return blocks;
}

/**
 * Markdown article → RenderedArticle (blocks, paragraphs, eligible sentences, stats, fingerprints,
 * warnings). Pure and deterministic: the same input always yields identical output.
 */
export async function renderArticle(input: RenderInput): Promise<RenderedArticle> {
  const bodyMd = input.bodyMd.replace(/\r\n?/g, '\n');
  const warnings: RenderWarning[] = [];
  if (!bodyMd.trim()) warnings.push({ code: 'EMPTY_BODY', message: 'The article body is empty.' });

  await getHighlighter();
  const mdast = parseMarkdown(bodyMd);
  dropRawHtml(mdast, warnings);
  figureMarkers(mdast, warnings);
  checkCodeLangs(mdast, warnings);
  headingShift(mdast);
  const paragraphs = assignParagraphIds(mdast);
  const sentences = buildSentences(paragraphs);

  const hast = await mdastToHast(mdast);
  const blocks = toBlocks(hast);

  // Document order (stable sort keeps same-line warnings in emission order).
  const ordered = warnings
    .map((w, i) => ({ w, i }))
    .sort((a, b) => (a.w.line ?? 0) - (b.w.line ?? 0) || a.i - b.i)
    .map(({ w }) => w);

  return {
    blocks,
    paragraphs,
    sentences,
    stats: computeStats(paragraphs),
    fingerprints: computeFingerprints({ ...input, bodyMd }, paragraphs, sentences),
    warnings: ordered,
  };
}
