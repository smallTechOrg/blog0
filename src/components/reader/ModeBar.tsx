'use client';

import { Icon } from '@/components/design/Icon';

/* The strip above the content: which mode this is, the title, and an X.
   In Read the X is the way back to all articles (it replaces the old back
   link); in Listen it returns to Read, the way the deck's X does. */
export interface ModeBarProps {
  mode: 'read' | 'listen';
  title: string;
  onClose: () => void;
  /** The X's label; defaults to "Back to all articles" (Read) / "Close the player" (Listen). */
  closeLabel?: string;
}

export function ModeBar({ mode, title, onClose, closeLabel }: ModeBarProps) {
  const listening = mode === 'listen';
  return (
    <div className="modebar">
      <div className="modebar__crumb">
        <span className="modebar__mode">{listening ? 'Listen' : 'Read'}</span>
        <span className="modebar__sep" aria-hidden="true" />
        <span className="modebar__title">{title}</span>
      </div>
      <button
        className="modebar__x"
        type="button"
        aria-label={closeLabel ?? (listening ? 'Close the player' : 'Back to all articles')}
        onClick={onClose}
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}
