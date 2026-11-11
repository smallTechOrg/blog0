import { createElement } from 'react';

import { InlineText } from './InlineText';

/* A typed line. The typing itself is page-wide (page-typer.ts types every visible character of
   Home, Archive and About in reading order), so this is the plain text in its tag — kept as a
   component for the design's `.typed` hook. `links` lets the text carry `[label](https://…)` links. */
export interface TypewriterProps {
  text: string;
  tag?: 'span' | 'p' | 'h1' | 'h2' | 'h3';
  className?: string;
  id?: string;
  links?: boolean;
}

export function Typewriter({ text, tag = 'span', className, id, links = false }: TypewriterProps) {
  const props = { className: className ? 'typed ' + className : 'typed', id };
  return links ? createElement(tag, props, createElement(InlineText, { text })) : createElement(tag, props, String(text || ''));
}
