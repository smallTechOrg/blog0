import { Fragment } from 'react';

import { parseInlineLinks } from '@/lib/inline-links';

/* Text with `[label](https://…)` links (see src/lib/inline-links.ts): plain parts as text, links as
   `a.inline` opening in a new tab, like article links. The typewriter walks the text nodes inside
   the links like any other text. */
export function InlineText({ text }: { text: string }) {
  return (
    <>
      {parseInlineLinks(String(text || '')).map((p, i) =>
        p.href ? (
          <a key={i} className="inline" href={p.href} target="_blank" rel="noopener noreferrer">
            {p.text}
          </a>
        ) : (
          <Fragment key={i}>{p.text}</Fragment>
        ),
      )}
    </>
  );
}
