// The reader's text ↔ audio follow decisions (pure — unit-tested in tests/unit/reader/listen-view.test.ts).
// Rules: spec/capabilities/listen-sync.md "Reader highlight" / "Auto-follow" + spec/ui.md §3 Listen.
// The live paragraph is the mark with the greatest tMs ≤ currentTime (activeMarkIndex over the
// server-resolved marks — estimated or stored); it changes on `timeupdate` and `seeked`. Following
// is on when the view opens; while on, each change of live paragraph asks for a scroll to centre.
// A manual scroll (wheel / touchmove / scroll key) turns following off; **Follow audio** turns it on
// and scrolls the current live paragraph at once; a paragraph click seeks and turns it back on.
// Programmatic scrolls never reach this module, so they can never turn following off.

import { SEEK_STEP_S, activeMarkIndex, type Mark } from '@/lib/listen/marks';

export type PlayerKeyAction = 'toggle' | 'back' | 'forward' | 'close' | null;

/** What can change the follow state. */
export type FollowEvent = 'manual-scroll' | 'follow-audio' | 'paragraph-click';

const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown']);
const TEXT_ENTRY_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

type FocusLike = { tagName?: string; isContentEditable?: boolean } | null | undefined;

/** Keys that scroll the page by themselves — a manual scroll that pauses following. */
export function isScrollKey(key: string): boolean {
  return SCROLL_KEYS.has(key);
}

/** True when the focus is in a text-entry control (input / textarea / select / contentEditable),
 *  which keeps the scroll keys for itself. A focused button does not. */
export function ownsScrollKeys(el: FocusLike): boolean {
  if (!el) return false;
  return TEXT_ENTRY_TAGS.has(String(el.tagName ?? '').toUpperCase()) || el.isContentEditable === true;
}

/** True when the focus is in a form control — a text-entry control or a button, whose own
 *  Space/Enter activation wins — where the player keys are ignored. */
export function isFormControl(el: FocusLike): boolean {
  return ownsScrollKeys(el) || String(el?.tagName ?? '').toUpperCase() === 'BUTTON';
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

/** What a window keydown drives on a player. */
export interface PlayerKeyTarget {
  toggle(): void;
  seek(seconds: number): void;
  currentTime(): number;
  durationS: number;
  close?: () => void;
}

/**
 * Applies a window keydown to a player (Space / ← / →, Escape → `close`), with `active` the focused
 * element. Returns true when the key was a player key; its default is prevented except for Escape.
 */
export function applyPlayerKey(e: { key: string; preventDefault(): void }, active: FocusLike, p: PlayerKeyTarget): boolean {
  const action = playerKeyAction(e.key, isFormControl(active));
  if (!action) return false;
  if (action === 'close') {
    p.close?.();
    return true;
  }
  e.preventDefault();
  if (action === 'toggle') p.toggle();
  else p.seek(seekTarget(action, p.currentTime(), p.durationS));
  return true;
}

/** The seek target (seconds) for ←/→, clamped to [0, duration] (an unknown duration only clamps at 0). */
export function seekTarget(action: 'back' | 'forward', currentS: number, durationS: number): number {
  const next = action === 'back' ? currentS - SEEK_STEP_S : currentS + SEEK_STEP_S;
  const hi = Number.isFinite(durationS) && durationS > 0 ? durationS : Number.POSITIVE_INFINITY;
  return Math.min(hi, Math.max(0, next));
}

/** The paragraph live at `tMs`, or null before the first mark (estimated marks start at 0). */
export function livePid(marks: readonly Mark[], tMs: number): string | null {
  const i = activeMarkIndex(marks, tMs);
  return i === -1 ? null : marks[i].pid;
}

/** The follow state after an event: a manual scroll pauses it; Follow audio and a paragraph click resume it. */
export function nextFollowing(_following: boolean, event: FollowEvent): boolean {
  return event !== 'manual-scroll';
}

/** Whether a scroll key press counts as a manual scroll (never while typing in a text-entry control). */
export function isManualScrollKey(key: string, inTextEntry: boolean): boolean {
  return !inTextEntry && isScrollKey(key);
}

/** A window keydown that pauses following: a scroll key, unless the focus owns the scroll keys. */
export function pausesFollow(key: string, active: FocusLike): boolean {
  return isManualScrollKey(key, ownsScrollKeys(active));
}

/** The slice of `<audio>` the sync reads: the position and the two events. */
export interface AudioLike {
  currentTime: number;
  addEventListener(type: 'timeupdate' | 'seeked', fn: () => void): void;
  removeEventListener(type: 'timeupdate' | 'seeked', fn: () => void): void;
}

export interface ListenSyncOptions {
  /** The live paragraph changed (null before the first mark) — move the highlight. */
  onLive: (pid: string | null) => void;
  /** Scroll this paragraph to the viewport centre (programmatic — never a "manual" scroll). */
  onScroll: (pid: string) => void;
  /** Following turned on/off — show or hide **Follow audio**. Fires only on a change. */
  onFollowChange?: (following: boolean) => void;
}

export interface ListenSync {
  /** Attaches to an audio element (syncs once immediately, without scrolling); returns the detach function. */
  bind(audio: AudioLike): () => void;
  /** Re-evaluates the live paragraph for a position (seconds). */
  update(currentTimeS: number): void;
  /** The reader scrolled by hand (wheel / touchmove / scroll key): following turns off. */
  noteManualScroll(): void;
  /** **Follow audio**: following turns on and the current live paragraph is scrolled to at once. */
  followAudio(): void;
  /**
   * A paragraph click / Enter / Space: its mark (ms) for the caller to seek to, or null when it has
   * none. Following turns on (the seek's `seeked` then moves — and scrolls — the highlight).
   */
  paragraphClicked(pid: string): number | null;
  /** Following right now. */
  following(): boolean;
  /** The live pid right now. */
  current(): string | null;
  /** A paragraph's mark (ms), or null when it has none. */
  markFor(pid: string): number | null;
}

/** The live-paragraph tracker + follow state machine for one open Listen view. */
export function createListenSync(marks: readonly Mark[], opts: ListenSyncOptions): ListenSync {
  const byPid = new Map(marks.map((m) => [m.pid, m.tMs]));
  let live: string | null = null;
  let following = true; // on each time the view opens

  function setFollowing(event: FollowEvent) {
    const next = nextFollowing(following, event);
    if (next === following) return;
    following = next;
    opts.onFollowChange?.(following);
  }

  function evaluate(currentTimeS: number, allowScroll: boolean) {
    const pid = livePid(marks, (Number.isFinite(currentTimeS) ? currentTimeS : 0) * 1000);
    if (pid === live) return;
    live = pid;
    opts.onLive(pid);
    if (pid !== null && following && allowScroll) opts.onScroll(pid);
  }

  return {
    update: (s) => evaluate(s, true),
    noteManualScroll() {
      setFollowing('manual-scroll');
    },
    followAudio() {
      setFollowing('follow-audio');
      if (live !== null) opts.onScroll(live);
    },
    paragraphClicked(pid) {
      const tMs = byPid.get(pid);
      if (tMs === undefined) return null;
      setFollowing('paragraph-click');
      return tMs;
    },
    following: () => following,
    current: () => live,
    markFor: (pid) => byPid.get(pid) ?? null,
    bind(audio) {
      const onTime = () => evaluate(audio.currentTime, true);
      audio.addEventListener('timeupdate', onTime);
      audio.addEventListener('seeked', onTime);
      // The view just opened: highlight where the audio is, but leave the page where the reader is.
      evaluate(audio.currentTime, false);
      return () => {
        audio.removeEventListener('timeupdate', onTime);
        audio.removeEventListener('seeked', onTime);
      };
    },
  };
}
