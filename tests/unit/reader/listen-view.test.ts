import { describe, expect, it } from 'vitest';

import {
  createListenSync,
  isScrollKey,
  livePid,
  playerKeyAction,
  seekTarget,
  shouldAutoScroll,
  type AudioLike,
} from '@/components/reader/listen-sync';
import { AUTOSCROLL_PAUSE_MS, SEEK_STEP_S } from '@/lib/listen/marks';

// spec/ui.md §3 Listen + spec/capabilities/listen-sync.md "Reader highlight": the live paragraph
// follows currentTime (timeupdate + seeked), one at a time, centred unless the reader scrolled
// manually in the last 4 s; Space / ← / → on the window, ignored in form controls.

const MARKS = [
  { pid: 'p-a', tMs: 500 },
  { pid: 'p-b', tMs: 4_000 },
  { pid: 'p-c', tMs: 9_250 },
];

/** A fake `<audio>`: currentTime + the two events the reader listens to. */
function fakeAudio(): AudioLike & { emit: (type: string) => void; listeners: Record<string, number> } {
  const map = new Map<string, Set<() => void>>();
  const listeners: Record<string, number> = {};
  return {
    currentTime: 0,
    listeners,
    addEventListener(type, fn) {
      if (!map.has(type)) map.set(type, new Set());
      map.get(type)!.add(fn);
      listeners[type] = map.get(type)!.size;
    },
    removeEventListener(type, fn) {
      map.get(type)?.delete(fn);
      listeners[type] = map.get(type)?.size ?? 0;
    },
    emit(type) {
      map.get(type)?.forEach((fn) => fn());
    },
  };
}

describe('livePid', () => {
  it('is null before the first mark, then the paragraph with the greatest tMs ≤ currentTime', () => {
    expect(livePid(MARKS, 0)).toBeNull();
    expect(livePid(MARKS, 499)).toBeNull();
    expect(livePid(MARKS, 500)).toBe('p-a');
    expect(livePid(MARKS, 3_999)).toBe('p-a');
    expect(livePid(MARKS, 4_000)).toBe('p-b');
    expect(livePid(MARKS, 60_000)).toBe('p-c');
  });

  it('is null without marks', () => {
    expect(livePid([], 5_000)).toBeNull();
  });
});

describe('shouldAutoScroll', () => {
  it('scrolls when the reader never scrolled, and again once the 4 s pause has elapsed', () => {
    expect(AUTOSCROLL_PAUSE_MS).toBe(4_000);
    expect(shouldAutoScroll(null, 10_000)).toBe(true);
    expect(shouldAutoScroll(10_000, 10_000)).toBe(false);
    expect(shouldAutoScroll(10_000, 10_000 + AUTOSCROLL_PAUSE_MS - 1)).toBe(false);
    expect(shouldAutoScroll(10_000, 10_000 + AUTOSCROLL_PAUSE_MS)).toBe(true);
  });
});

describe('isScrollKey', () => {
  it('names the keys that scroll the page (a manual scroll), not the player keys', () => {
    for (const k of ['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown']) expect(isScrollKey(k), k).toBe(true);
    for (const k of [' ', 'ArrowLeft', 'ArrowRight', 'Enter', 'Escape', 'a']) expect(isScrollKey(k), k).toBe(false);
  });
});

describe('playerKeyAction', () => {
  it('maps Space, ←, → and Escape on the window', () => {
    expect(playerKeyAction(' ', false)).toBe('toggle');
    expect(playerKeyAction('Spacebar', false)).toBe('toggle');
    expect(playerKeyAction('ArrowLeft', false)).toBe('back');
    expect(playerKeyAction('ArrowRight', false)).toBe('forward');
    expect(playerKeyAction('Escape', false)).toBe('close');
    expect(playerKeyAction('Enter', false)).toBeNull();
    expect(playerKeyAction('k', false)).toBeNull();
  });

  it('ignores the player keys while the focus is in a form control (Escape still closes)', () => {
    expect(playerKeyAction(' ', true)).toBeNull();
    expect(playerKeyAction('ArrowLeft', true)).toBeNull();
    expect(playerKeyAction('ArrowRight', true)).toBeNull();
    expect(playerKeyAction('Escape', true)).toBe('close');
  });
});

describe('seekTarget', () => {
  it('steps ±5 s and clamps to [0, duration]', () => {
    expect(SEEK_STEP_S).toBe(5);
    expect(seekTarget('back', 12, 100)).toBe(7);
    expect(seekTarget('forward', 12, 100)).toBe(17);
    expect(seekTarget('back', 3, 100)).toBe(0);
    expect(seekTarget('forward', 98, 100)).toBe(100);
    expect(seekTarget('forward', 5, Number.NaN)).toBe(10);
  });
});

describe('createListenSync (fake <audio>)', () => {
  it('reports the live paragraph on timeupdate and seeked, only when it changes, with scroll on', () => {
    const audio = fakeAudio();
    const seen: Array<[string | null, boolean]> = [];
    let now = 100_000;
    const sync = createListenSync(MARKS, { onLive: (pid, o) => seen.push([pid, o.scroll]), now: () => now });
    const unbind = sync.bind(audio);
    expect(audio.listeners).toEqual({ timeupdate: 1, seeked: 1 });
    expect(seen).toEqual([]); // nothing live at 0

    audio.currentTime = 0.3;
    audio.emit('timeupdate');
    expect(seen).toEqual([]);

    audio.currentTime = 0.6;
    audio.emit('timeupdate');
    audio.currentTime = 2.0;
    audio.emit('timeupdate');
    expect(seen).toEqual([['p-a', true]]);

    audio.currentTime = 9.3;
    audio.emit('seeked');
    expect(seen).toEqual([
      ['p-a', true],
      ['p-c', true],
    ]);

    // back before the first mark: the highlight clears (no scroll)
    audio.currentTime = 0;
    audio.emit('seeked');
    expect(seen[2]).toEqual([null, false]);
    expect(sync.current()).toBeNull();

    now += 1;
    unbind();
    expect(audio.listeners).toEqual({ timeupdate: 0, seeked: 0 });
    audio.currentTime = 5;
    audio.emit('timeupdate');
    expect(seen).toHaveLength(3);
  });

  it('skips the auto-scroll for 4 s after a manual scroll, then resumes', () => {
    const audio = fakeAudio();
    const seen: Array<[string | null, boolean]> = [];
    let now = 50_000;
    const sync = createListenSync(MARKS, { onLive: (pid, o) => seen.push([pid, o.scroll]), now: () => now });
    sync.bind(audio);

    sync.noteManualScroll();
    audio.currentTime = 1;
    audio.emit('timeupdate');
    expect(seen).toEqual([['p-a', false]]);

    now += 2_000;
    audio.currentTime = 4.5;
    audio.emit('timeupdate');
    expect(seen[1]).toEqual(['p-b', false]);

    now += AUTOSCROLL_PAUSE_MS;
    audio.currentTime = 10;
    audio.emit('timeupdate');
    expect(seen[2]).toEqual(['p-c', true]);
  });

  it('re-syncs immediately when asked (e.g. after the text mounts), even without an event', () => {
    const audio = fakeAudio();
    audio.currentTime = 4.2;
    const seen: Array<string | null> = [];
    const sync = createListenSync(MARKS, { onLive: (pid) => seen.push(pid), now: () => 0 });
    sync.bind(audio);
    expect(seen).toEqual(['p-b']);
    expect(sync.current()).toBe('p-b');
    expect(sync.markFor('p-c')).toBe(9_250);
    expect(sync.markFor('nope')).toBeNull();
  });
});
