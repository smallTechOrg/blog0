'use client';

import type { KeyboardEvent } from 'react';

import type { SubscriberCounts } from '@/lib/api/dto';

import { STATUS_FILTERS, type StatusFilterValue } from './subscribers-api';

// Status filter (spec/ui.md §4 "Subscribers"): a tablist of `.pill` buttons with counts; the
// active one is `is-on`. Arrow keys move between pills.

export interface StatusFilterProps {
  counts: SubscriberCounts | null;
  value: StatusFilterValue;
  onChange: (value: StatusFilterValue) => void;
}

export function StatusFilter({ counts, value, onChange }: StatusFilterProps) {
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const i = STATUS_FILTERS.findIndex((f) => f.value === value);
    const next = STATUS_FILTERS[(i + (e.key === 'ArrowRight' ? 1 : STATUS_FILTERS.length - 1)) % STATUS_FILTERS.length];
    onChange(next.value);
    const buttons = e.currentTarget.querySelectorAll<HTMLButtonElement>('button');
    buttons[STATUS_FILTERS.indexOf(next)]?.focus();
  }

  return (
    <div className="pills" role="tablist" aria-label="Filter by status" onKeyDown={onKeyDown}>
      {STATUS_FILTERS.map((f) => {
        const on = f.value === value;
        const n = counts ? counts[f.value] : null;
        return (
          <button
            key={f.value}
            type="button"
            role="tab"
            className={on ? 'pill is-on' : 'pill'}
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(f.value)}
          >
            {f.label}
            {n !== null ? <span className="pill__n">{n}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
