// The reader's text ↔ audio sync decisions (pure — unit-tested in tests/unit/reader/listen-view.test.ts).
// Rules: spec/capabilities/listen-sync.md "Reader highlight" + spec/ui.md §3 Listen. The live
// paragraph is the mark with the greatest tMs ≤ currentTime (activeMarkIndex); it changes on
// `timeupdate` and `seeked`; a change scrolls it to centre unless the reader scrolled manually in
// the last AUTOSCROLL_PAUSE_MS. Space / ← / → work on the window, not in form controls.

import { AUTOSCROLL_PAUSE_MS, SEEK_STEP_S, activeMarkIndex, type Mark } from '@/lib/listen/marks';

export type PlayerKeyAction = 'toggle' | 'back' | 'forward' | 'close' | null;

const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown']);
const FORM_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON']);

/** Keys that scroll the page by themselves — a manual scroll for the auto-scroll pause. */
export function isScrollKey(key: string): boolean {
  return SCROLL_KEYS.has(key);
}

/** True when the keyboard focus sits in a form control (or editable text), where keys belong to it. */
export function isFormControl(el: { tagName?: string; isContentEditable?: boolean } | null | undefined): boolean {
  if (!el) return false;
  return FORM_TAGS.has(String(el.tagName ?? '').toUpperCase()) || el.isContentEditable === true;
}

/** Space play/pause, ←/→ ±5 s (ignored in a form control); Escape always closes. */
export function playerKeyAction(key: string, inFormControl: boolean): PlayerKeyAction {
  if (key === 'Escape' || key === 'Esc') return 'close';
  if (inFormControl) return null;
  if (key === ' ' || key === 'Spacebar') return 'toggle';
  if (key === 'ArrowLeft') return 'back';
  if (key === 'ArrowRight') return 'forward';
  return null;
}

/** The seek target (seconds) for ←/→, clamped to [0, duration] (an unknown duration only clamps at 0). */
export function seekTarget(action: 'back' | 'forward', currentS: number, durationS: number): number {
  const next = action === 'back' ? currentS - SEEK_STEP_S : currentS + SEEK_STEP_S;
  const hi = Number.isFinite(durationS) && durationS > 0 ? durationS : Number.POSITIVE_INFINITY;
  return Math.min(hi, Math.max(0, next));
}

/** The paragraph live at `tMs`, or null before the first mark. */
export function livePid(marks: readonly Mark[], tMs: number): string | null {
  const i = activeMarkIndex(marks, tMs);
  return i === -1 ? null : marks[i].pid;
}

/** Auto-scroll is allowed unless the reader scrolled manually within the last 4 s. */
export function shouldAutoScroll(lastManualAt: number | null, now: number): boolean {
  return lastManualAt === null || now - lastManualAt >= AUTOSCROLL_PAUSE_MS;
}

/** The slice of `<audio>` the sync reads: the position and the two events. */
export interface AudioLike {
  currentTime: number;
  addEventListener(type: 'timeupdate' | 'seeked', fn: () => void): void;
  removeEventListener(type: 'timeupdate' | 'seeked', fn: () => void): void;
}

export interface ListenSync {
  /** Attaches to an audio element (syncs once immediately); returns the detach function. */
  bind(audio: AudioLike): () => void;
  /** Re-evaluates the live paragraph for a position (seconds). */
  update(currentTimeS: number): void;
  /** The reader scrolled by hand: pause the auto-scroll for AUTOSCROLL_PAUSE_MS. */
  noteManualScroll(): void;
  /** The live pid right now. */
  current(): string | null;
  /** A paragraph's mark (ms), or null when it has none. */
  markFor(pid: string): number | null;
}

/**
 * The live-paragraph tracker: `onLive(pid, { scroll })` fires only when the live paragraph
 * changes; `scroll` says whether the change should scroll it into view.
 */
export function createListenSync(
  marks: readonly Mark[],
  opts: { onLive: (pid: string | null, o: { scroll: boolean }) => void; now?: () => number },
): ListenSync {
  const now = opts.now ?? (() => Date.now());
  const byPid = new Map(marks.map((m) => [m.pid, m.tMs]));
  let live: string | null = null;
  let lastManualAt: number | null = null;

  function update(currentTimeS: number) {
    const pid = livePid(marks, (Number.isFinite(currentTimeS) ? currentTimeS : 0) * 1000);
    if (pid === live) return;
    live = pid;
    opts.onLive(pid, { scroll: pid !== null && shouldAutoScroll(lastManualAt, now()) });
  }

  return {
    update,
    noteManualScroll() {
      lastManualAt = now();
    },
    current: () => live,
    markFor: (pid) => byPid.get(pid) ?? null,
    bind(audio) {
      const onTime = () => update(audio.currentTime);
      audio.addEventListener('timeupdate', onTime);
      audio.addEventListener('seeked', onTime);
      onTime();
      return () => {
        audio.removeEventListener('timeupdate', onTime);
        audio.removeEventListener('seeked', onTime);
      };
    },
  };
}
