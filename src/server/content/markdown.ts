import 'server-only';

import rehypeSlug from 'rehype-slug';
import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';

import type { HNode, HRoot, MdRoot } from './ast';
import { highlightCode } from './highlight';
import { externalLinks } from './plugins/external-links';
import { images } from './plugins/images';
import { safeUrls } from './plugins/safe-urls';
import { wrapTables } from './plugins/tables';

// unified stages of the pipeline (spec/architecture.md §4). The mdast transforms between parse
// and toHast live in render.ts so it can collect paragraphs, sentences and warnings in order.

const parser = unified().use(remarkParse).use(remarkGfm).freeze();

/** Markdown → mdast (CommonMark + GFM: tables, footnotes, strikethrough, autolinks, task lists). */
export function parseMarkdown(md: string): MdRoot {
  return parser.runSync(parser.parse(md)) as unknown as MdRoot;
}

const toHastProcessor = unified()
  .use(remarkRehype, {
    allowDangerousHtml: false,
    footnoteLabel: 'Notes',
    footnoteLabelTagName: 'h2',
    footnoteLabelProperties: { className: ['footnotes-label'] },
  })
  .use(rehypeSlug)
  .freeze();

/**
 * mdast → hast: remark-rehype (raw HTML dropped, footnotes as a visible "Notes" section) →
 * rehype-slug → safe URLs → links → images → tables → Shiki.
 */
export async function mdastToHast(
  mdast: MdRoot,
  opts: { imageDims?: ReadonlyMap<string, { width: number; height: number }> } = {},
): Promise<HRoot> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- local structural mdast type
  const hast = (await toHastProcessor.run(mdast as any)) as unknown as HRoot;
  safeUrls(hast);
  externalLinks(hast);
  images(hast, opts.imageDims);
  wrapTables(hast);
  await highlightCode(hast);
  return hast;
}

const stringifier = unified().use(rehypeStringify).freeze();

/** Serialises hast nodes as an HTML fragment. */
export function hastToHtml(nodes: HNode[]): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- local structural hast type
  return stringifier.stringify({ type: 'root', children: nodes } as any);
}
