'use client';

import { fmtClockMs } from '@/lib/listen/marks';

import type { TapState } from './useTapSync';

// Sync controls above the paragraph list (spec/ui.md §4 Listen tab → Sync controls): Start
// syncing (with the reason when disabled), and while syncing the live clock, "Next: paragraph k
// of n", the big tap button (Space), Undo last tap (Backspace), Restart, Stop.

export interface SyncPanelProps {
  state: TapState;
  paragraphCount: number;
  /** Player position in ms (updated by the tab while playing). */
  currentMs: number;
  hasAudio: boolean;
  editorDirty: boolean;
  busy: boolean;
  onStart: () => void;
  onTap: () => void;
  onUndo: () => void;
  onRestart: () => void;
  onStop: () => void;
  onGoToWrite?: () => void;
}

export const SAVE_TEXT_FIRST = 'Save your text changes first — sync works against the saved article.';
export const CONFIRM_RESTART = 'Restart syncing? Every mark will be cleared and the recording plays from the start.';

export function startDisabledReason(input: { hasAudio: boolean; editorDirty: boolean; paragraphCount: number; phase: TapState['phase'] }): string | null {
  if (!input.hasAudio) return 'Upload a recording first.';
  if (input.paragraphCount === 0) return 'The saved article has no paragraphs to sync.';
  if (input.editorDirty) return SAVE_TEXT_FIRST;
  if (input.phase === 'syncing') return 'Already syncing.';
  return null;
}

export function SyncPanel(props: SyncPanelProps) {
  const { state, paragraphCount: n, currentMs, hasAudio, editorDirty, busy } = props;
  const syncing = state.phase === 'syncing';
  const k = Math.min(state.nextIndex + 1, n);
  const reason = startDisabledReason({ hasAudio, editorDirty, paragraphCount: n, phase: state.phase });
  const hasAnyMark = state.times.some((t) => t !== null);

  return (
    <div className="syncpanel" data-phase={state.phase}>
      {!syncing ? (
        <div className="syncpanel__row">
          <button
            type="button"
            className="admin-btn admin-btn--primary"
            disabled={reason !== null || busy}
            title={reason ?? undefined}
            onClick={props.onStart}
            data-testid="start-syncing"
          >
            {hasAnyMark ? 'Start syncing again' : 'Start syncing'}
          </button>
          {reason && hasAudio ? (
            <span className="admin-hint">
              {reason}
              {editorDirty && props.onGoToWrite ? (
                <>
                  {' '}
                  <button type="button" className="linkbtn" onClick={props.onGoToWrite}>
                    Go to Write
                  </button>
                </>
              ) : null}
            </span>
          ) : null}
          {state.phase === 'complete' ? (
            <p className="admin-ok syncpanel__notice" role="status">
              All {n} paragraphs marked — check a few, nudge if needed, then Save sync.
            </p>
          ) : null}
          {state.phase === 'ended' ? (
            <p className="admin-error syncpanel__notice" role="alert">
              The recording ended before paragraph {k} — redo from an earlier paragraph, or upload a longer recording.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="syncpanel__live">
          <div className="syncpanel__status">
            {/* The clock ticks every frame — outside the live region so it is never announced. */}
            <span className="syncpanel__clock mono" data-testid="sync-clock">
              {fmtClockMs(currentMs)}
            </span>
            {/* Changes only when a tap (or undo) moves the next paragraph: one announcement per tap. */}
            <span className="syncpanel__next" aria-live="polite" aria-atomic="true">
              Next: paragraph {k} of {n}
            </span>
          </div>
          <button type="button" className="tapbtn" onClick={props.onTap} aria-keyshortcuts="Space" data-testid="tap-button">
            Tap — paragraph {k} starts now
          </button>
          <div className="syncpanel__row">
            <button type="button" className="admin-btn admin-btn--small" onClick={props.onUndo} disabled={!hasAnyMark} aria-keyshortcuts="Backspace">
              Undo last tap
            </button>
            <button
              type="button"
              className="admin-btn admin-btn--small admin-btn--ghost"
              onClick={() => {
                if (window.confirm(CONFIRM_RESTART)) props.onRestart();
              }}
            >
              Restart
            </button>
            <button type="button" className="admin-btn admin-btn--small admin-btn--ghost" onClick={props.onStop} data-testid="stop-syncing">
              Stop
            </button>
            <span className="admin-hint">Space = tap · Backspace = undo</span>
          </div>
        </div>
      )}
    </div>
  );
}
