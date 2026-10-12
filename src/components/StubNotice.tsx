import type { ReactNode } from 'react';

// A clearly-labelled, non-functional placeholder for a feature a later phase builds
// (spec/ui.md §5 `.stub`). Reads "Coming in a later phase — <children>" so a stub is never
// mistaken for a bug.

export interface StubNoticeProps {
  /** What arrives, and when — e.g. "Featured and About arrive in Phase 2." */
  children: ReactNode;
  /** Leading label; defaults to "Coming in a later phase". */
  label?: string;
  className?: string;
}

export function StubNotice({ children, label = 'Coming in a later phase', className }: StubNoticeProps) {
  return (
    <div className={className ? 'stub ' + className : 'stub'} role="note">
      <span className="stub__label">{label}</span> — {children}
    </div>
  );
}
