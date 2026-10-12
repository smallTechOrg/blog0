'use client';

import { Icon, type IconName } from '@/components/design/Icon';
import { cx } from '@/components/design/motion';

export type ReaderMode = 'read' | 'tldr' | 'listen';

/* Each way in carries its own duration, so the capsule is the one place
   that answers "how long will this take me". The same capsule docks under
   the article, sits in the TLDR deck's foot and in the card's Listen sheet. */
export interface ModeCapsuleProps {
  /** Which mode is lit (`tldr` while the deck is open). */
  active: ReaderMode;
  /** Minutes; `tldr: null` disables TLDR ("No summary yet"), `listen: null` disables Listen ("No recording yet"). */
  times: { read: number; tldr: number | null; listen: number | null };
  onPick: (mode: ReaderMode) => void;
  /** Extra class on `.modes` (the deck's `modes--deck`). */
  className?: string;
  /** `false` disables a mode that has a time but no way to open it from here. */
  enabled?: Partial<Record<ReaderMode, boolean>>;
}

const MODES: Array<[ReaderMode, string, IconName]> = [
  ['read', 'Read', 'text'],
  ['tldr', 'TLDR', 'bolt'],
  ['listen', 'Listen', 'headphones'],
];

/** The disabled reason per mode (design: "Audio is not recorded yet"; divergence 9 resolved). */
const MISSING: Record<ReaderMode, { title: string; aria: string }> = {
  read: { title: '', aria: 'Read' },
  tldr: { title: 'No summary yet', aria: 'TLDR — no summary yet' },
  listen: { title: 'No recording yet', aria: 'Listen — no recording yet' },
};

/** The Read / TLDR / Listen capsule (design `.modes.modes--timed`). Place inside `.modedock`. */
export function ModeCapsule({ active, times, onPick, className, enabled }: ModeCapsuleProps) {
  return (
    <div className={cx('modes', className, 'modes--timed')} role="tablist" aria-label="How to take this in">
      {MODES.map(([key, label, icon]) => {
        const on = active === key;
        const min = times[key];
        const missing = min == null;
        return (
          <button
            key={key}
            type="button"
            className={cx('mode', on && 'is-on')}
            role="tab"
            aria-selected={on ? 'true' : 'false'}
            aria-label={missing ? MISSING[key].aria : label + ' — ' + min + ' min'}
            disabled={missing || enabled?.[key] === false}
            title={missing ? MISSING[key].title : undefined}
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
