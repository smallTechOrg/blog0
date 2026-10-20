'use client';

import { Fragment, memo, useRef } from 'react';

import { SPLIT_STAGGER, cx, splitPieces, useEnter, type SplitBy } from './motion';

export interface SplitHeadlineProps {
  text: string;
  tag?: 'h1' | 'h2' | 'h3' | 'h4';
  by?: SplitBy;
  className?: string;
  id?: string;
}

/* Headline-level only — never body copy, section headings or nav labels. */
function SplitHeadlineImpl({ text, tag = 'h1', by = 'word', className, id }: SplitHeadlineProps) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEnter(ref);
  const pieces = splitPieces(text, by);
  const Tag = tag;
  return (
    <Tag ref={ref} id={id} className={cx('split', className)} aria-label={text}>
      {pieces.map((p, i) => (
        <Fragment key={i}>
          <span className="sw" aria-hidden="true" style={{ animationDelay: i * SPLIT_STAGGER + 'ms' }}>
            {p}
          </span>
          {by === 'word' && i < pieces.length - 1 ? ' ' : null}
        </Fragment>
      ))}
    </Tag>
  );
}

export const SplitHeadline = memo(
  SplitHeadlineImpl,
  (a, b) => a.text === b.text && a.className === b.className,
);
