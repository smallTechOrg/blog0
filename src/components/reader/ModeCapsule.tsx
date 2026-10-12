'use client';

import { Icon, type IconName } from '@/components/design/Icon';
import { cx } from '@/components/design/motion';

export type ReaderMode = 'read' | 'tldr' | 'listen';

/* Each way in carries its own duration, so the capsule is the one place
   that answers "how long will this take me". */
export interface ModeCapsuleProps {
  /** Which mode is lit (`tldr` while the deck is open). */
  active: ReaderMode;
  /** Minutes; `tldr: null` disables TLDR ("No summary yet"), `listen: null` shows "—". */
  times: { read: number; tldr: number | null; listen: number | null };
  onPick: (mode: ReaderMode) => void;
}

const MODES: Array<[ReaderMode, string, IconName]> = [
  ['read', 'Read', 'text'],
  ['tldr', 'TLDR', 'bolt'],
  ['listen', 'Listen', 'headphones'],
];

/** The Read / TLDR / Listen capsule (design `.modes.modes--timed`). Place inside `.modedock`. */
export function ModeCapsule({ active, times, onPick }: ModeCapsuleProps) {
  return (
    <div className="modes modes--timed" role="tablist" aria-label="How to take this in">
      {MODES.map(([key, label, icon]) => {
        const on = active === key;
        const min = times[key];
        const noDeck = key === 'tldr' && min == null;
        const aria =
          min != null
            ? label + ' — ' + min + ' min'
            : key === 'tldr'
              ? 'TLDR — no summary yet'
              : label + ' — coming in a later phase';
        return (
          <button
            key={key}
            type="button"
            className={cx('mode', on && 'is-on')}
            role="tab"
            aria-selected={on ? 'true' : 'false'}
            aria-label={aria}
            disabled={noDeck}
            title={noDeck ? 'No summary yet' : undefined}
            onClick={() => onPick(key)}
          >
            <Icon name={icon} size={14} />
            <span className="mode__t">{label}</span>
            <span className="mode__d">{min != null ? min + ' min' : '—'}</span>
          </button>
        );
      })}
    </div>
  );
}
