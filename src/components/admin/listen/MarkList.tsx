'use client';

import { useEffect, useRef } from 'react';

import type { ListenParagraphDto, MarkIssueCode } from '@/lib/api/dto-phase3';
import { fmtClockMs, nudgeMark, type Mark } from '@/lib/listen/marks';

import type { TapState } from './useTapSync';

// Paragraph rows (spec/ui.md §4 Listen tab → Paragraphs): ordinal, the first ~90 chars, the
// heading path as an eyebrow when it changes, the mark time, nudge ±250 ms, Redo from here, ▶.
// Row states: .is-next (about to be tapped), .is-marked, .is-missing (stale: no mark), .is-live
// (follows the player during preview playback).

export interface MarkListProps {
  paragraphs: ListenParagraphDto[];
  state: TapState;
  durationMs: number;
  /** Paragraphs the server reports as unmarked (stale) — shown with the "no mark" badge. */
  missingPids: ReadonlySet<string>;
  /** Index of the row the player is in (preview playback), or −1. */
  liveIndex: number;
  /** Server-side MARKS_INVALID reasons, keyed by pid. */
  issues: ReadonlyMap<string, MarkIssueCode[]>;
  disabled: boolean;
  onNudge: (index: number, deltaMs: 250 | -250) => void;
  onRedoFrom: (index: number) => void;
  onPreview: (index: number) => void;
}

export const EXCERPT_CHARS = 90;

export function excerpt(text: string, max = EXCERPT_CHARS): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return t.slice(0, max).replace(/\s+\S*$/, '') + '…';
}

const ISSUE_TEXT: Record<MarkIssueCode, string> = {
  UNKNOWN_PID: 'not in the article any more',
  MISSING_PID: 'needs a mark',
  DUPLICATE_PID: 'marked twice',
  OUT_OF_ORDER: 'out of order',
  NOT_INCREASING: 'must come after the previous mark',
  OUT_OF_RANGE: 'outside the recording',
};

export function issueText(code: MarkIssueCode): string {
  return ISSUE_TEXT[code];
}

/** Can mark `index` move by `delta` (strict ordering + bounds)? */
export function canNudge(times: ReadonlyArray<number | null>, pids: readonly string[], index: number, delta: 250 | -250, durationMs: number): boolean {
  const marks: Mark[] = [];
  let pos = -1;
  times.forEach((t, i) => {
    if (t === null) return;
    if (i === index) pos = marks.length;
    marks.push({ pid: pids[i], tMs: t });
  });
  return pos >= 0 && nudgeMark(marks, pos, delta, durationMs) !== null;
}

export function MarkList(props: MarkListProps) {
  const { paragraphs, state, durationMs, missingPids, liveIndex, issues, disabled } = props;
  const listRef = useRef<HTMLOListElement>(null);
  const syncing = state.phase === 'syncing';
  const pids = paragraphs.map((p) => p.pid);

  // Keep the paragraph about to be tapped in view while syncing.
  useEffect(() => {
    if (!syncing) return;
    const row = listRef.current?.querySelector<HTMLElement>('.marklist__row.is-next');
    row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [syncing, state.nextIndex]);

  if (paragraphs.length === 0) {
    return <p className="admin-muted">The saved article has no paragraphs yet — write some text and save.</p>;
  }

  let lastHeading = '';
  return (
    <ol className="marklist" ref={listRef} aria-label="Paragraphs">
      {paragraphs.map((p, i) => {
        const t = state.times[i] ?? null;
        const heading = p.headingPath.join(' › ');
        const showHeading = heading !== lastHeading;
        lastHeading = heading;
        const isNext = syncing && i === state.nextIndex;
        const isMissing = t === null && (missingPids.has(p.pid) || state.phase === 'idle');
        const rowIssues = issues.get(p.pid) ?? [];
        const cls = [
          'marklist__row',
          isNext ? 'is-next' : '',
          t !== null ? 'is-marked' : '',
          isMissing && !syncing ? 'is-missing' : '',
          i === liveIndex ? 'is-live' : '',
          rowIssues.length ? 'is-invalid' : '',
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <li key={p.pid} className={cls} data-pid={p.pid} data-index={i}>
            {showHeading && heading ? <span className="marklist__eyebrow">{heading}</span> : null}
            <span className="marklist__ord mono">{String(i + 1).padStart(2, '0')}</span>
            <span className="marklist__text">
              {excerpt(p.text)}
              {isMissing && !syncing ? <span className="marklist__badge">no mark</span> : null}
              {rowIssues.length ? <span className="marklist__issue">{rowIssues.map(issueText).join(' · ')}</span> : null}
            </span>
            <span className="marklist__time mono" data-testid="mark-time">
              {t === null ? '—' : fmtClockMs(t)}
            </span>
            <span className="marklist__tools">
              <button
                type="button"
                className="admin-btn admin-btn--small marklist__btn"
                aria-label={`Nudge earlier (paragraph ${i + 1})`}
                title="−250 ms"
                disabled={disabled || syncing || t === null || !canNudge(state.times, pids, i, -250, durationMs)}
                onClick={() => props.onNudge(i, -250)}
              >
                −250 ms
              </button>
              <button
                type="button"
                className="admin-btn admin-btn--small marklist__btn"
                aria-label={`Nudge later (paragraph ${i + 1})`}
                title="+250 ms"
                disabled={disabled || syncing || t === null || !canNudge(state.times, pids, i, 250, durationMs)}
                onClick={() => props.onNudge(i, 250)}
              >
                +250 ms
              </button>
              <button
                type="button"
                className="admin-btn admin-btn--small admin-btn--ghost marklist__btn"
                disabled={disabled}
                onClick={() => props.onRedoFrom(i)}
              >
                Redo from here
              </button>
              <button
                type="button"
                className="admin-btn admin-btn--small admin-btn--ghost marklist__btn marklist__play"
                aria-label={`Play from paragraph ${i + 1}`}
                disabled={disabled || syncing || t === null}
                onClick={() => props.onPreview(i)}
              >
                ▶
              </button>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
