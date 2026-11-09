'use client';

import { Icon } from '@/components/design/Icon';

/* The design's Share button (`.btn-outline` + share icon). It only reports the press: the host
   copies its share text + link and opens the ShareMenu (or the native sheet) against it
   (spec/ui.md §3 "Share"). Used by the deck's end slide and the article foot. */
export interface ShareLinkButtonProps {
  /** `keyboard` is true when the press came from Enter/Space (the menu then takes focus). */
  onShare: (button: HTMLButtonElement, keyboard: boolean) => void;
  /** Button label; the design default is "Share". */
  label?: string;
  /** Accessible name; defaults to the label. */
  ariaLabel?: string;
  /** True while this button's menu is open. */
  expanded?: boolean;
}

export function ShareLinkButton({ onShare, label, ariaLabel, expanded }: ShareLinkButtonProps) {
  return (
    <button
      className="btn-outline"
      type="button"
      aria-haspopup="dialog"
      aria-expanded={expanded ? 'true' : 'false'}
      aria-label={ariaLabel || label || 'Share'}
      onClick={(e) => onShare(e.currentTarget, e.detail === 0)}
    >
      <Icon name="share" size={15} />
      {label || 'Share'}
    </button>
  );
}
