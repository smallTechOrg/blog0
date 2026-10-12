import { describe, expect, it } from 'vitest';

import {
  applyPlayerKey,
  createListenSync,
  isFormControl,
  isManualScrollKey,
  isScrollKey,
  livePid,
  nextFollowing,
  ownsScrollKeys,
  pausesFollow,
  playerKeyAction,
  seekTarget,
  type AudioLike,
  type ListenSync,
} from '@/components/reader/listen-sync';
import { estimateMarks } from '@/lib/listen/estimate';
import { SEEK_STEP_S } from '@/lib/listen/marks';

// spec/ui.md §3 Listen + spec/capabilities/listen-sync.md "Reader highlight" / "Auto-follow": the
// live paragraph follows currentTime (timeupdate + seeked), one at a time; following is on when the
// view opens and scrolls each new live paragraph to centre; a manual scroll (wheel / touchmove /
// scroll key) pauses it and shows Follow audio; Follow audio resumes and scrolls once at once; a
// paragraph click seeks to its mark and resumes; Space / ← / → on the window, ignored in form controls.

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

describe('nextFollowing (follow pause/resume decisions)', () => {
  it('a manual scroll pauses following; Follow audio and a paragraph click resume it', () => {
    expect(nextFollowing(true, 'manual-scroll')).toBe(false);
    expect(nextFollowing(false, 'manual-scroll')).toBe(false);
    expect(nextFollowing(false, 'follow-audio')).toBe(true);
    expect(nextFollowing(true, 'follow-audio')).toBe(true);
    expect(nextFollowing(false, 'paragraph-click')).toBe(true);
    expect(nextFollowing(true, 'paragraph-click')).toBe(true);
  });

  it('counts scroll keys as manual only outside form controls', () => {
    expect(isManualScrollKey('PageDown', false)).toBe(true);
    expect(isManualScrollKey('ArrowUp', false)).toBe(true);
    expect(isManualScrollKey('PageDown', true)).toBe(false);
    expect(isManualScrollKey('ArrowLeft', false)).toBe(false);
    expect(isManualScrollKey(' ', false)).toBe(false);
  });
});

const BUTTON = { tagName: 'BUTTON' };
const TEXT_ENTRY = [{ tagName: 'INPUT' }, { tagName: 'textarea' }, { tagName: 'SELECT' }, { tagName: 'DIV', isContentEditable: true }];

describe('ownsScrollKeys / isFormControl (two different focus predicates)', () => {
  it('text-entry controls own the scroll keys; a button does not', () => {
    for (const el of TEXT_ENTRY) expect(ownsScrollKeys(el), el.tagName).toBe(true);
    expect(ownsScrollKeys(BUTTON)).toBe(false);
    expect(ownsScrollKeys({ tagName: 'DIV' })).toBe(false);
    expect(ownsScrollKeys(null)).toBe(false);
  });

  it('the player-key predicate also counts a button (its own Space/Enter activation wins)', () => {
    for (const el of TEXT_ENTRY) expect(isFormControl(el), el.tagName).toBe(true);
    expect(isFormControl(BUTTON)).toBe(true);
    expect(isFormControl({ tagName: 'P' })).toBe(false);
    expect(isFormControl(undefined)).toBe(false);
  });
});

describe('pausesFollow (a scroll key on the window pauses following)', () => {
  it('pauses with nothing focused and with a button focused (e.g. ▶)', () => {
    expect(pausesFollow('PageDown', null)).toBe(true);
    expect(pausesFollow('PageDown', BUTTON)).toBe(true);
    expect(pausesFollow('End', BUTTON)).toBe(true);
  });

  it('never pauses while typing in a text-entry control, nor for non-scroll keys', () => {
    for (const el of TEXT_ENTRY) expect(pausesFollow('PageDown', el), el.tagName).toBe(false);
    expect(pausesFollow('ArrowLeft', null)).toBe(false);
    expect(pausesFollow(' ', BUTTON)).toBe(false);
  });
});

describe('applyPlayerKey (shared by AudioPlayer and ListenView)', () => {
  function player(currentS = 12, durationS = 100) {
    const calls: string[] = [];
    return {
      calls,
      target: {
        toggle: () => calls.push('toggle'),
        seek: (s: number) => calls.push('seek ' + s),
        currentTime: () => currentS,
        durationS,
        close: () => calls.push('close'),
      },
    };
  }
  function key(k: string) {
    const e = { key: k, prevented: false, preventDefault() { e.prevented = true; } };
    return e;
  }

  it('Space toggles, ←/→ seek ±5 s (default prevented); Escape closes without preventing', () => {
    const p = player();
    const space = key(' ');
    expect(applyPlayerKey(space, null, p.target)).toBe(true);
    expect(space.prevented).toBe(true);
    applyPlayerKey(key('ArrowLeft'), null, p.target);
    applyPlayerKey(key('ArrowRight'), null, p.target);
    const esc = key('Escape');
    expect(applyPlayerKey(esc, BUTTON, p.target)).toBe(true);
    expect(esc.prevented).toBe(false);
    expect(p.calls).toEqual(['toggle', 'seek 7', 'seek 17', 'close']);
  });

  it('ignores the player keys with a form control or a button focused, and unrelated keys', () => {
    const p = player();
    for (const el of [...TEXT_ENTRY, BUTTON]) {
      const e = key(' ');
      expect(applyPlayerKey(e, el, p.target)).toBe(false);
      expect(e.prevented).toBe(false);
    }
    expect(applyPlayerKey(key('Enter'), null, p.target)).toBe(false);
    expect(p.calls).toEqual([]);
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

type Seen = { live: Array<string | null>; scrolls: string[]; follow: boolean[] };

/** A tracker wired to a fake <audio>, recording highlight moves, scroll requests and follow changes. */
function rig(marks = MARKS, startS = 0): { audio: ReturnType<typeof fakeAudio>; sync: ListenSync; seen: Seen; unbind: () => void } {
  const audio = fakeAudio();
  audio.currentTime = startS;
  const seen: Seen = { live: [], scrolls: [], follow: [] };
  const sync = createListenSync(marks, {
    onLive: (pid) => seen.live.push(pid),
    onScroll: (pid) => seen.scrolls.push(pid),
    onFollowChange: (f) => seen.follow.push(f),
  });
  const unbind = sync.bind(audio);
  return { audio, sync, seen, unbind };
}

function at(audio: ReturnType<typeof fakeAudio>, seconds: number, type: 'timeupdate' | 'seeked' = 'timeupdate') {
  audio.currentTime = seconds;
  audio.emit(type);
}

describe('createListenSync (fake <audio>, fake scroll target)', () => {
  it('moves the live paragraph on timeupdate and seeked, only when it changes; each change scrolls while following', () => {
    const { audio, sync, seen, unbind } = rig();
    expect(audio.listeners).toEqual({ timeupdate: 1, seeked: 1 });
    expect(sync.following()).toBe(true);
    expect(seen.live).toEqual([]); // nothing live at 0 with these marks

    at(audio, 0.3);
    expect(seen.live).toEqual([]);
    at(audio, 0.6);
    at(audio, 2.0);
    expect(seen.live).toEqual(['p-a']);
    expect(seen.scrolls).toEqual(['p-a']);

    at(audio, 9.3, 'seeked');
    expect(seen.live).toEqual(['p-a', 'p-c']);
    expect(seen.scrolls).toEqual(['p-a', 'p-c']);

    // back before the first mark: the highlight clears, nothing to scroll to
    at(audio, 0, 'seeked');
    expect(seen.live[2]).toBeNull();
    expect(seen.scrolls).toHaveLength(2);
    expect(sync.current()).toBeNull();

    unbind();
    expect(audio.listeners).toEqual({ timeupdate: 0, seeked: 0 });
    at(audio, 5);
    expect(seen.live).toHaveLength(3);
  });

  it('highlights where the audio is when the view opens, without scrolling the page', () => {
    const { sync, seen } = rig(MARKS, 4.2);
    expect(seen.live).toEqual(['p-b']);
    expect(seen.scrolls).toEqual([]);
    expect(sync.current()).toBe('p-b');
    expect(sync.markFor('p-c')).toBe(9_250);
    expect(sync.markFor('nope')).toBeNull();
  });

  it('with estimated marks paragraph 1 is live from 0, also while paused at 0', () => {
    const marks = estimateMarks(
      [
        { pid: 'p-1', words: 10 },
        { pid: 'p-2', words: 0 },
        { pid: 'p-3', words: 20 },
      ],
      10_000,
    );
    expect(marks.map((m) => m.tMs)).toEqual([0, 3333, 3768]);
    const { audio, seen } = rig(marks, 0);
    expect(seen.live).toEqual(['p-1']);
    at(audio, 3.5);
    expect(seen.live).toEqual(['p-1', 'p-2']);
    at(audio, 3.8);
    expect(seen.live).toEqual(['p-1', 'p-2', 'p-3']);
  });

  for (const how of ['wheel', 'touchmove', 'PageDown'] as const) {
    it(`after a manual scroll (${how}) no further change requests a scroll and Follow audio shows; the highlight keeps moving`, () => {
      const { audio, sync, seen } = rig();
      at(audio, 1);
      expect(seen.scrolls).toEqual(['p-a']);

      // ListenView maps wheel / touchmove / a scroll key (also with ▶ focused) to noteManualScroll.
      if (how === 'PageDown') expect(pausesFollow(how, BUTTON)).toBe(true);
      sync.noteManualScroll();
      expect(sync.following()).toBe(false);
      expect(seen.follow).toEqual([false]); // Follow audio becomes visible

      at(audio, 4.5);
      at(audio, 10, 'seeked'); // a seek while paused does not scroll either
      expect(seen.live).toEqual(['p-a', 'p-b', 'p-c']);
      expect(seen.scrolls).toEqual(['p-a']);

      // more manual scrolls change nothing (no repeated follow notifications)
      sync.noteManualScroll();
      expect(seen.follow).toEqual([false]);
    });
  }

  it('Follow audio hides the button and requests exactly one scroll to the current live paragraph at once', () => {
    const { audio, sync, seen } = rig();
    at(audio, 1);
    sync.noteManualScroll();
    at(audio, 5);
    expect(seen.scrolls).toEqual(['p-a']);

    sync.followAudio();
    expect(sync.following()).toBe(true);
    expect(seen.follow).toEqual([false, true]);
    expect(seen.scrolls).toEqual(['p-a', 'p-b']); // one scroll, to the live pid, with no audio event

    // following again: the next change scrolls as usual
    at(audio, 9.5);
    expect(seen.scrolls).toEqual(['p-a', 'p-b', 'p-c']);
  });

  it('Follow audio before the first mark turns following on without a scroll', () => {
    const { sync, seen } = rig();
    sync.noteManualScroll();
    sync.followAudio();
    expect(sync.following()).toBe(true);
    expect(seen.scrolls).toEqual([]);
  });

  it('a paragraph click returns its mark to seek to and turns following back on', () => {
    const { audio, sync, seen } = rig();
    at(audio, 10);
    sync.noteManualScroll();
    expect(sync.following()).toBe(false);

    const tMs = sync.paragraphClicked('p-b');
    expect(tMs).toBe(4_000);
    expect(sync.following()).toBe(true);
    expect(seen.follow).toEqual([false, true]);

    // the caller seeks the audio; the seeked event moves (and scrolls) the highlight
    at(audio, tMs! / 1000, 'seeked');
    expect(sync.current()).toBe('p-b');
    expect(seen.scrolls.at(-1)).toBe('p-b');
  });

  it('a click on a paragraph without a mark does nothing (no seek, follow unchanged)', () => {
    const { sync, seen } = rig();
    sync.noteManualScroll();
    expect(sync.paragraphClicked('p-unknown')).toBeNull();
    expect(sync.following()).toBe(false);
    expect(seen.follow).toEqual([false]);
  });

  it('a programmatic scroll never turns following off', () => {
    const { audio, sync, seen } = rig();
    // Scroll requests are carried out by the view (scrollIntoView); nothing feeds them back as manual.
    for (const s of [1, 4.5, 9.5, 0.6, 4.1]) at(audio, s, 'seeked');
    sync.followAudio();
    expect(seen.scrolls.length).toBeGreaterThanOrEqual(5);
    expect(sync.following()).toBe(true);
    expect(seen.follow).toEqual([]);
  });
});
