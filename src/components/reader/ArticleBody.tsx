'use client';

import { memo } from 'react';

import type { Block } from '@/lib/content/types';

/* Injected once and never re-rendered while its html is unchanged (design ArticleProse).
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

/** An article's body: its `.prose` html blocks, in order. Wrap in `.readbody`. */
export function ArticleBody({ blocks }: ArticleBodyProps) {
  return (
    <>
      {blocks.map((b, i) => (
        <ArticleProse key={'m' + i} html={b.html} />
      ))}
    </>
  );
}
