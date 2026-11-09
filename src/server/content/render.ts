import 'server-only';

import { type Block, type RenderedArticle, type RenderInput, type RenderWarning } from '@/lib/content/types';

import { isWhitespaceText, type HNode, type HRoot } from './ast';
import { computeFingerprints } from './fingerprint';
import { getHighlighter } from './highlight';
import { hastToHtml, mdastToHast, parseMarkdown } from './markdown';
import { assignParagraphIds } from './paragraph-ids';
import { checkCodeLangs } from './plugins/code-langs';
import { checkEmbeddedImages } from './plugins/embedded-images';
import { headingShift } from './plugins/heading-shift';
import { dropRawHtml } from './plugins/raw-html';
import { buildSentences } from './sentences';
import { computeStats } from './stats';

/** Bump on ANY change to the pipeline's output (keys the render cache). */
export const RENDER_VERSION = 'r4';

/** The top-level hast children as html blocks: one block, or none for an empty body. */
function toBlocks(hast: HRoot): Block[] {
  const nodes: HNode[] = hast.children;
  return nodes.some((n) => !isWhitespaceText(n)) ? [{ kind: 'html', html: hastToHtml(nodes).trim() }] : [];
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
  checkEmbeddedImages(mdast, warnings);
  checkCodeLangs(mdast, warnings);
  headingShift(mdast);
  const paragraphs = assignParagraphIds(mdast);
  const sentences = buildSentences(paragraphs);

  const hast = await mdastToHast(mdast, { imageDims: input.imageDims });
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
