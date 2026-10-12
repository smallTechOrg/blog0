'use client';

import { memo } from 'react';

import { figureFor } from '@/components/figures/registry';
import type { Block } from '@/lib/content/types';

/* Injected once and never re-rendered while its html is unchanged, so a
   figure changing state never reconciles the text around it (design ArticleProse).
   The html comes from the server content pipeline, which never passes raw HTML through. */
const ArticleProse = memo(
  function ArticleProse({ html }: { html: string }) {
    return <div className="prose" dangerouslySetInnerHTML={{ __html: html }} />;
  },
  (a, b) => a.html === b.html,
);

export interface ArticleBodyProps {
  /** `RenderedArticle.blocks` (or the preview endpoint's `blocks`). */
  blocks: ReadonlyArray<Block>;
}

/** An article's body: alternating `.prose` html blocks and interactive figures, in order.
 *  Unknown figure ids render nothing (the editor lists them as warnings). Wrap in `.readbody`. */
export function ArticleBody({ blocks }: ArticleBodyProps) {
  return (
    <>
      {blocks.map((b, i) => {
        if (b.kind === 'html') return <ArticleProse key={'m' + i} html={b.html} />;
        const Fig = b.known ? figureFor(b.figureId) : null;
        return Fig ? <Fig key={'f' + i} /> : null;
      })}
    </>
  );
}
