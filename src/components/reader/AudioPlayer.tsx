'use client';

import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';

import { fmtClock, listenMinutes } from '@/lib/listen/marks';

import { isFormControl, playerKeyAction, seekTarget } from './listen-sync';

/* The design's AudioPanel (design-app.js) bound to a real <audio> (divergence 28):
   the same `.audio` markup, ▶ / ⏸, a 0.25 s range in seconds, m:ss clocks — only
   the note changes, to "Read by <byline> · N min". The element is hidden; the
   Listen view and the card overlay drive it through the handle. */
export interface AudioPlayerAudio {
  url: string;
  mimeType: 'audio/mpeg' | 'audio/mp4';
  durationMs: number;
}

export interface AudioPlayerHandle {
  /** The element itself (null before mount). */
  audio(): HTMLAudioElement | null;
  /** Position in seconds. */
  currentTime(): number;
  /** Jump to a position (seconds); the play state is unchanged. */
  seek(seconds: number): void;
  /** Play ↔ pause. */
  toggle(): void;
  /** Moves the keyboard focus to the play button (Follow audio hands focus back to the player). */
  focusPlay(): void;
}

export interface AudioPlayerProps {
  audio: AudioPlayerAudio;
  bylineName: string;
  /** Space play/pause, ←/→ ±5 s on the window (ignored in form controls). The Listen view
      handles its own keys (paragraph focus first), so it passes false. */
  hotkeys?: boolean;
  /** Escape (with `hotkeys`) — the overlay closes. */
  onEscape?: () => void;
  ref?: Ref<AudioPlayerHandle>;
}

const LOAD_ERROR = 'Couldn’t load the recording.';

export function AudioPlayer({ audio, bylineName, hotkeys = false, onEscape, ref }: AudioPlayerProps) {
  const el = useRef<HTMLAudioElement>(null);
  const playBtn = useRef<HTMLButtonElement>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [failed, setFailed] = useState(false);
  /* the thumb follows timeupdate except while the reader drags it */
  const dragging = useRef(false);
  const dur = audio.durationMs / 1000;

  const seek = useCallback((seconds: number) => {
    const a = el.current;
    if (!a) return;
    const t = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
    try {
      a.currentTime = t;
    } catch {
      /* not seekable yet (metadata still loading): the position is applied on canplay below */
    }
    setPos(t);
  }, []);

  const toggle = useCallback(() => {
    const a = el.current;
    if (!a || failed) return;
    if (a.paused) {
      void a.play().catch(() => setFailed(true));
    } else {
      a.pause();
    }
  }, [failed]);

  useImperativeHandle(
    ref,
    () => ({
      audio: () => el.current,
      currentTime: () => el.current?.currentTime ?? 0,
      seek,
      toggle,
      focusPlay: () => playBtn.current?.focus(),
    }),
    [seek, toggle],
  );

  useEffect(() => {
    const a = el.current;
    if (!a) return;
    const onTime = () => {
      if (!dragging.current) setPos(a.currentTime);
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onError = () => {
      setFailed(true);
      setPlaying(false);
    };
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('seeked', onTime);
    a.addEventListener('play', onPlay);
    a.addEventListener('playing', onPlay);
    a.addEventListener('pause', onPause);
    a.addEventListener('ended', onPause);
    a.addEventListener('error', onError);
    return () => {
      a.removeEventListener('timeupdate', onTime);
      a.removeEventListener('seeked', onTime);
      a.removeEventListener('play', onPlay);
      a.removeEventListener('playing', onPlay);
      a.removeEventListener('pause', onPause);
      a.removeEventListener('ended', onPause);
      a.removeEventListener('error', onError);
    };
  }, []);

  /* the overlay's keys: Space / ← / → on the window, Escape closes */
  useEffect(() => {
    if (!hotkeys) return;
    function onKey(e: KeyboardEvent) {
      const action = playerKeyAction(e.key, isFormControl(document.activeElement as HTMLElement | null));
      if (!action) return;
      if (action === 'close') {
        onEscape?.();
        return;
      }
      e.preventDefault();
      if (action === 'toggle') toggle();
      else seek(seekTarget(action, el.current?.currentTime ?? 0, dur));
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hotkeys, onEscape, toggle, seek, dur]);

  const minutes = listenMinutes(audio.durationMs);

  return (
    <div className="audio">
      <button
        ref={playBtn}
        className="audio__play"
        type="button"
        aria-label={playing ? 'Pause' : 'Play'}
        aria-pressed={playing}
        disabled={failed}
        onClick={toggle}
      >
        {playing ? '⏸' : '▶'}
      </button>
      <div className="audio__main">
        <input
          className="audio__range"
          type="range"
          min={0}
          max={dur}
          step={0.25}
          value={Math.min(pos, dur)}
          aria-label="Seek"
          aria-valuetext={fmtClock(pos * 1000) + ' of ' + fmtClock(audio.durationMs)}
          disabled={failed}
          onPointerDown={() => {
            dragging.current = true;
          }}
          onPointerUp={() => {
            dragging.current = false;
          }}
          onPointerCancel={() => {
            dragging.current = false;
          }}
          onChange={(e) => seek(Number(e.target.value))}
        />
        <div className="audio__times">
          <span>{fmtClock(pos * 1000)}</span>
          <span>{fmtClock(audio.durationMs)}</span>
        </div>
      </div>
      <p className="audio__note" role={failed ? 'alert' : undefined}>
        {failed ? LOAD_ERROR : 'Read by ' + bylineName + ' · ' + minutes + ' min'}
      </p>
      <audio ref={el} preload="metadata" hidden>
        <source src={audio.url} type={audio.mimeType} />
      </audio>
    </div>
  );
}
