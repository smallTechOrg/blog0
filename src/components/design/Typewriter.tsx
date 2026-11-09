import { createElement } from 'react';

/* A typed line. The typing itself is page-wide (page-typer.ts types every visible character of
   Home, Archive and About in reading order), so this is the plain text in its tag — kept as a
   component for the design's `.typed` hook. */
export interface TypewriterProps {
  text: string;
  tag?: 'span' | 'p' | 'h1' | 'h2' | 'h3';
  className?: string;
  id?: string;
}

export function Typewriter({ text, tag = 'span', className, id }: TypewriterProps) {
  return createElement(tag, { className: className ? 'typed ' + className : 'typed', id }, String(text || ''));
}
