'use client';

import { useCallback, useLayoutEffect, useReducer, useRef, type RefObject } from 'react';

import { nudgeMark, TAP_DEBOUNCE_MS, type Mark } from '@/lib/listen/marks';

// Tap-along state machine (spec/capabilities/listen-sync.md → "Sync walks the list in order").
// `tapSyncReducer` is pure and unit-tested; `useTapSync` wraps it with the <audio> side effects
// (seek / play / pause) and the global Space / Backspace shortcuts.

export type TapPhase = 'idle' | 'syncing' | 'complete' | 'ended';

export interface TapState {
  phase: TapPhase;
  /** One slot per paragraph (document order): the mark time in ms, or null when unmarked. */
  times: Array<number | null>;
  /** The paragraph about to be tapped while syncing. */
  nextIndex: number;
  /** Wall-clock ms of the last accepted tap (debounce). */
  lastTapAt: number | null;
}

export type TapAction =
  | { type: 'load'; marks: readonly Mark[] }
  | { type: 'start' }
  | { type: 'tap'; tMs: number; now: number }
  | { type: 'undo' }
  | { type: 'restart' }
  | { type: 'redoFrom'; index: number }
  | { type: 'stop' }
  | { type: 'ended' }
  | { type: 'nudge'; index: number; deltaMs: 250 | -250 };

export interface TapContext {
  pids: readonly string[];
  durationMs: number;
}

/** Server marks → per-paragraph times; marks for vanished paragraphs (orphans) are dropped. */
export function timesFromMarks(pids: readonly string[], marks: readonly Mark[]): Array<number | null> {
  const byPid = new Map<string, number>();
  for (const m of marks) if (!byPid.has(m.pid)) byPid.set(m.pid, m.tMs);
  return pids.map((pid) => byPid.get(pid) ?? null);
}

export function initialTapState(pids: readonly string[], marks: readonly Mark[]): TapState {
  const times = timesFromMarks(pids, marks);
  return { phase: 'idle', times, nextIndex: times.length, lastTapAt: null };
}

/** The marks in document order (unmarked paragraphs skipped). */
export function marksOf(state: TapState, pids: readonly string[]): Mark[] {
  const out: Mark[] = [];
  state.times.forEach((t, i) => {
    if (t !== null && i < pids.length) out.push({ pid: pids[i], tMs: t });
  });
  return out;
}

export function unmarkedCount(state: TapState): number {
  return state.times.filter((t) => t === null).length;
}

function lastMarkedBefore(times: ReadonlyArray<number | null>, index: number): number | null {
  for (let i = index - 1; i >= 0; i--) if (times[i] !== null) return times[i];
  return null;
}

function cleared(times: ReadonlyArray<number | null>, from: number): Array<number | null> {
  return times.map((t, i) => (i >= from ? null : t));
}

export function tapSyncReducer(state: TapState, action: TapAction, ctx: TapContext): TapState {
  const n = ctx.pids.length;
  switch (action.type) {
    case 'load':
      return initialTapState(ctx.pids, action.marks);
    case 'start':
    case 'restart':
      return { phase: 'syncing', times: ctx.pids.map(() => null), nextIndex: 0, lastTapAt: null };
    case 'tap': {
      if (state.phase !== 'syncing' || state.nextIndex >= n) return state;
      if (state.lastTapAt !== null && action.now - state.lastTapAt < TAP_DEBOUNCE_MS) return state;
      const tMs = Math.floor(action.tMs);
      if (!Number.isFinite(tMs) || tMs < 0 || tMs >= ctx.durationMs) return state;
      const prev = lastMarkedBefore(state.times, state.nextIndex);
      if (prev !== null && tMs <= prev) return state;
      const times = state.times.slice();
      times[state.nextIndex] = tMs;
      const nextIndex = state.nextIndex + 1;
      return { phase: nextIndex >= n ? 'complete' : 'syncing', times, nextIndex, lastTapAt: action.now };
    }
    case 'undo': {
      if (state.phase === 'idle') return state;
      let i = state.nextIndex - 1;
      while (i >= 0 && state.times[i] === null) i--;
      if (i < 0) return state;
      const times = cleared(state.times, i);
      return { phase: 'syncing', times, nextIndex: i, lastTapAt: null };
    }
    case 'redoFrom': {
      if (!Number.isInteger(action.index) || action.index < 0 || action.index >= n) return state;
      return { phase: 'syncing', times: cleared(state.times, action.index), nextIndex: action.index, lastTapAt: null };
    }
    case 'stop':
      if (state.phase === 'idle') return state;
      return { ...state, phase: 'idle' };
    case 'ended':
      if (state.phase !== 'syncing') return state;
      return { ...state, phase: 'ended' };
    case 'nudge': {
      const marks = marksOf(state, ctx.pids);
      const pos = marks.findIndex((m) => m.pid === ctx.pids[action.index]);
      if (pos < 0) return state;
      const next = nudgeMark(marks, pos, action.deltaMs, ctx.durationMs);
      if (!next) return state;
      const times = state.times.slice();
      times[action.index] = next[pos].tMs;
      return { ...state, times };
    }
    default:
      return state;
  }
}

/** Seek target (ms) for an undo: 1 s before the removed mark. */
export function undoSeekMs(state: TapState): number | null {
  if (state.phase === 'idle') return null;
  let i = state.nextIndex - 1;
  while (i >= 0 && state.times[i] === null) i--;
  if (i < 0) return null;
  return Math.max(0, (state.times[i] as number) - 1000);
}

/** Seek target (ms) for Redo from paragraph k: the mark of k−1 (or 0). */
export function redoSeekMs(state: TapState, index: number): number {
  return lastMarkedBefore(state.times, index) ?? 0;
}

export interface UseTapSyncInput {
  pids: readonly string[];
  durationMs: number;
  serverMarks: readonly Mark[];
  audioRef: RefObject<HTMLAudioElement | null>;
}

export interface TapSyncApi {
  state: TapState;
  dirty: boolean;
  start: () => void;
  tap: () => void;
  undo: () => void;
  restart: () => void;
  redoFrom: (index: number) => void;
  stop: () => void;
  /** The player's `ended` fired. */
  ended: () => void;
  nudge: (index: number, deltaMs: 250 | -250) => void;
  discard: () => void;
  /** Adopt new server marks (after a save or an audio change). */
  load: (marks: readonly Mark[]) => void;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export function useTapSync({ pids, durationMs, serverMarks, audioRef }: UseTapSyncInput): TapSyncApi {
  const ctxRef = useRef<TapContext>({ pids, durationMs });
  useLayoutEffect(() => {
    ctxRef.current = { pids, durationMs };
  });
  const [state, dispatch] = useReducer(
    (s: TapState, a: TapAction) => tapSyncReducer(s, a, ctxRef.current),
    { pids, marks: serverMarks },
    ({ pids: p, marks }) => initialTapState(p, marks),
  );
  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  });

  const audio = useCallback(() => audioRef.current, [audioRef]);

  const seekAndPlay = useCallback(
    (ms: number) => {
      const el = audio();
      if (!el) return;
      try {
        el.currentTime = ms / 1000;
      } catch {
        // metadata not loaded yet — the play() below starts from 0
      }
      void el.play()?.catch(() => undefined);
    },
    [audio],
  );

  const pause = useCallback(() => {
    audio()?.pause();
  }, [audio]);

  const start = useCallback(() => {
    dispatch({ type: 'start' });
    seekAndPlay(0);
  }, [seekAndPlay]);

  const restart = useCallback(() => {
    dispatch({ type: 'restart' });
    seekAndPlay(0);
  }, [seekAndPlay]);

  const tap = useCallback(() => {
    const el = audio();
    if (!el || stateRef.current.phase !== 'syncing') return;
    const before = stateRef.current;
    const next = tapSyncReducer(before, { type: 'tap', tMs: el.currentTime * 1000, now: Date.now() }, ctxRef.current);
    if (next === before) return;
    dispatch({ type: 'tap', tMs: el.currentTime * 1000, now: Date.now() });
    if (next.phase === 'complete') el.pause();
  }, [audio]);

  const undo = useCallback(() => {
    const seek = undoSeekMs(stateRef.current);
    if (seek === null) return;
    dispatch({ type: 'undo' });
    seekAndPlay(seek);
  }, [seekAndPlay]);

  const redoFrom = useCallback(
    (index: number) => {
      const seek = redoSeekMs(stateRef.current, index);
      dispatch({ type: 'redoFrom', index });
      seekAndPlay(seek);
    },
    [seekAndPlay],
  );

  const stop = useCallback(() => {
    dispatch({ type: 'stop' });
    pause();
  }, [pause]);

  const nudge = useCallback((index: number, deltaMs: 250 | -250) => dispatch({ type: 'nudge', index, deltaMs }), []);
  const load = useCallback((marks: readonly Mark[]) => dispatch({ type: 'load', marks }), []);
  const discard = useCallback(() => {
    dispatch({ type: 'load', marks: serverMarks });
    pause();
  }, [serverMarks, pause]);

  // The recording ran out before every paragraph was marked (wired to the player's `ended`).
  const ended = useCallback(() => dispatch({ type: 'ended' }), []);

  // Space = tap, Backspace = undo, anywhere on the page while syncing (not inside form fields).
  const syncing = state.phase === 'syncing';
  useLayoutEffect(() => {
    if (!syncing) return;
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        if (!e.repeat) tap();
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        if (!e.repeat) undo();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [syncing, tap, undo]);

  const serverTimes = timesFromMarks(pids, serverMarks);
  const dirty = state.times.length !== serverTimes.length || state.times.some((t, i) => t !== serverTimes[i]);

  return { state, dirty, start, tap, undo, restart, redoFrom, stop, ended, nudge, discard, load };
}
