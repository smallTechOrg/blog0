'use client';

import { useRef, type CSSProperties, type ReactNode } from 'react';

import { cx, useEnter } from './motion';

export { dekDelay } from './motion';

export interface DekProps {
  tag?: 'p' | 'div';
  className?: string;
  /** ms before the dek animates in (usually `dekDelay(headline)`). */
  delay?: number;
  children?: ReactNode;
}

export function Dek({ tag = 'p', className, delay = 0, children }: DekProps) {
  const pRef = useRef<HTMLParagraphElement>(null);
  const divRef = useRef<HTMLDivElement>(null);
  useEnter(tag === 'div' ? divRef : pRef);
  const cls = cx('dekin', className);
  const style: CSSProperties = { animationDelay: delay + 'ms' };
  return tag === 'div' ? (
    <div ref={divRef} className={cls} style={style}>
      {children}
    </div>
  ) : (
    <p ref={pRef} className={cls} style={style}>
      {children}
    </p>
  );
}
