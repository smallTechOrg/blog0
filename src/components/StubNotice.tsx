import type { ReactNode } from 'react';

// A clearly-labelled, non-functional placeholder for a deferred feature (spec/ui.md §5 `.stub`;
// used by the editor's History tab). Reads "<label> — <children>" so a stub is never mistaken for
// a bug.

export interface StubNoticeProps {
  /** What arrives, and when. */
  children: ReactNode;
  /** Leading label; defaults to "Not built yet". */
  label?: string;
  className?: string;
}

export function StubNotice({ children, label = 'Not built yet', className }: StubNoticeProps) {
  return (
    <div className={className ? 'stub ' + className : 'stub'} role="note">
      <span className="stub__label">{label}</span> — {children}
    </div>
  );
}
