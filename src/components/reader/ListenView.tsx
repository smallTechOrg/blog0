'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

import { prefersReducedMotion } from '@/components/design/motion';
import { typePage } from '@/components/design/page-typer';
import type { Block } from '@/lib/content/types';
import { clickTagPath, shareClickIgnored } from '@/lib/share-surface';
import type { ListenViewModel } from '@/lib/view-models';

import { ArticleBody } from './ArticleBody';
import { AudioPlayer, type AudioPlayerHandle } from './AudioPlayer';
import { glideStep, paragraphProgress, scrollTargetFor } from './listen-follow';
import { applyPlayerKey, createListenSync, pausesFollow, type ListenSync } from './listen-sync';

/* ============================================================
   Listen (spec/ui.md §3 Listen; divergences 28–29): the design's listen
   frame — tag, title, player — with the article text beside it. The player
   is primary; the text follows it on the server-resolved (estimated or
   stored) marks: the paragraph being read carries .is-live (a hook only —
   nothing is painted from the estimate) and, while following, comes into view. A manual scroll pauses following and shows
   **Follow audio** in the sticky lead; clicking it scrolls back to the live
   paragraph, resumes following and hands focus to ▶. A paragraph click seeks
   the audio to its start and resumes following; Space / ← / → drive the
   player from the window. The highlight is toggled straight on the DOM (the
   prose is memoised html), exactly like the share highlight.
   SMA-36: the view types in when it opens, and while the audio plays (and
   motion is allowed) the text scrolls slowly with it instead of jumping a
   paragraph at a time — the reading position inside the live paragraph is
   estimated from the time between its mark and the next (listen-follow.ts).
   The same view runs on the article page and in the overlay opened from a
   home card; in the overlay the text scrolls inside the panel.
   ============================================================ */
export interface ListenViewProps {
  topic: string;
  title: string;
  bylineName: string;
  blocks: ReadonlyArray<Block>;
  listen: ListenViewModel;
  /** Escape / the X: back to Read. */
  onClose: () => void;
}

const LIVE = 'is-live';
/** additions.css paints it like `blog0-untyped`. */
const LISTEN_TYPE_HIGHLIGHT = 'blog0-listen-untyped';

export function ListenView({ topic, title, bylineName, blocks, listen, onClose }: ListenViewProps) {
  const player = useRef<AudioPlayerHandle>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const leadRef = useRef<HTMLDivElement>(null);
  const syncRef = useRef<ListenSync | null>(null);
  const [following, setFollowing] = useState(true);
  const textId = useId();
  const live = useRef({ onClose });
  useLayoutEffect(() => {
    live.current = { onClose };
  });

  /* SMA-36: the view types in when it opens — what is on screen, then the rest at once — the same
     whether it was opened on the article page or from a home card. Its own highlight, so a page
     typewriter still running underneath never clears it (or the other way round). */
  const sectionRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const root = sectionRef.current;
    if (!root || prefersReducedMotion()) return;
    return typePage(root, { highlight: LISTEN_TYPE_HIGHLIGHT, untilFold: true });
  }, []);

  /* highlight + auto-scroll, bound to the player's <audio> */
  useEffect(() => {
    const scope = textRef.current;
    const audio = player.current?.audio();
    if (!scope || !audio) return;

    function paragraph(pid: string): HTMLElement | null {
      return scope!.querySelector<HTMLElement>('.para[data-pid="' + CSS.escape(pid) + '"]');
    }

    /* SMA-36: the glide (below) moves the page while the audio plays */
    const glides = !prefersReducedMotion();
    function scrollToPara(pid: string) {
      if (glides && !audio!.paused) return;
      const el = paragraph(pid);
      if (!el) return;
      try {
        el.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      } catch {
        el.scrollIntoView();
      }
    }

    const sync = createListenSync(listen.marks, {
      onLive(pid) {
        scope.querySelectorAll('.para.' + LIVE).forEach((el) => el.classList.remove(LIVE));
        if (pid) paragraph(pid)?.classList.add(LIVE);
      },
      onScroll: scrollToPara,
      onFollowChange: setFollowing,
    });
    syncRef.current = sync;
    const unbind = sync.bind(audio);
    const stopGlide = glides ? startGlide(audio, scope, leadRef.current, listen, sync, paragraph) : () => {};

    /* paragraphs are reachable from the keyboard: Enter / Space seeks */
    const focusable = Array.from(scope.querySelectorAll<HTMLElement>('.para[data-pid]'));
    focusable.forEach((el) => {
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    });

    /* a paragraph click / Enter / Space: seek to its start (play state unchanged), follow again */
    function seekTo(pid: string): boolean {
      const tMs = sync.paragraphClicked(pid);
      if (tMs === null) return false;
      player.current?.seek(tMs / 1000);
      return true;
    }
    function pidOf(target: EventTarget | null): string | null {
      if (!(target instanceof Element)) return null;
      // links, buttons, form controls and figures keep their own behaviour
      if (shareClickIgnored(clickTagPath(target, scope))) return null;
      const para = target.closest<HTMLElement>('.para[data-pid]');
      return para && scope!.contains(para) ? para.dataset.pid || null : null;
    }

    const onClick = (e: MouseEvent) => {
      const pid = pidOf(e.target);
      if (pid && seekTo(pid)) e.preventDefault();
    };

    /* manual scrolls pause following; programmatic ones (scrollIntoView) never fire these */
    const manual = () => sync.noteManualScroll();
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const active = document.activeElement as HTMLElement | null;
      // a scroll key pauses following — also with ▶ focused, never while typing
      if (pausesFollow(e.key, active)) {
        manual();
        return;
      }
      const focusedPara = active?.closest<HTMLElement>('.para[data-pid]');
      if (focusedPara && scope.contains(focusedPara) && (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar')) {
        if (seekTo(focusedPara.dataset.pid || '')) e.preventDefault();
        return;
      }
      const p = player.current;
      if (!p) return;
      applyPlayerKey(e, active, {
        toggle: p.toggle,
        seek: p.seek,
        currentTime: p.currentTime,
        durationS: listen.durationMs / 1000,
        close: () => live.current.onClose(),
      });
    };

    scope.addEventListener('click', onClick);
    window.addEventListener('wheel', manual, { passive: true });
    window.addEventListener('touchmove', manual, { passive: true });
    window.addEventListener('keydown', onKey);
    return () => {
      stopGlide();
      unbind();
      syncRef.current = null;
      setFollowing(true); // a fresh tracker starts out following
      scope.removeEventListener('click', onClick);
      window.removeEventListener('wheel', manual);
      window.removeEventListener('touchmove', manual);
      window.removeEventListener('keydown', onKey);
      scope.querySelectorAll('.para.' + LIVE).forEach((el) => el.classList.remove(LIVE));
    };
  }, [listen]);

  return (
    <section ref={sectionRef} className="listenview listenview--synced" aria-label="Listen to this article">
      <div className="listenview__lead" ref={leadRef}>
        {topic ? <span className="tag">{topic}</span> : null}
        <h1>{title}</h1>
        <AudioPlayer
          ref={player}
          audio={{ url: listen.audioUrl, mimeType: listen.mimeType, durationMs: listen.durationMs }}
          bylineName={bylineName}
        />
        <button
          type="button"
          className="btn-outline listenview__follow"
          aria-controls={textId}
          hidden={following}
          onClick={() => {
            syncRef.current?.followAudio();
            player.current?.focusPlay();
          }}
        >
          Follow audio
        </button>
      </div>
      <div className="listenview__text" id={textId}>
        <div className="readbody" ref={textRef}>
          <ArticleBody blocks={blocks} />
        </div>
      </div>
    </section>
  );
}

/** What the text scrolls in: the nearest scrolling ancestor (the Listen overlay's panel), else the window. */
interface Scroller {
  y(): number;
  set(y: number): void;
  max(): number;
  /** The scroller's visible band in viewport px. */
  band(): { top: number; bottom: number };
}

function scrollerOf(el: HTMLElement): Scroller {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) {
      const box = p;
      return {
        y: () => box.scrollTop,
        set: (y) => box.scrollTo(0, y),
        max: () => box.scrollHeight - box.clientHeight,
        band: () => {
          const r = box.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom };
        },
      };
    }
  }
  return {
    y: () => window.scrollY,
    set: (y) => window.scrollTo(0, y),
    max: () => document.documentElement.scrollHeight - window.innerHeight,
    band: () => ({ top: 0, bottom: window.innerHeight }),
  };
}

/** The band of the scroller the text is read in: below the site header, the mode strip and — when
 *  it sits above the text (one column) — the sticky lead. */
function readingBand(scroller: Scroller, lead: HTMLElement | null, scope: HTMLElement): { top: number; bottom: number } {
  const view = scroller.band();
  const bottom = view.bottom;
  let top = view.top;
  for (const sel of ['.sitehead', '.modebar']) {
    for (const el of Array.from(document.querySelectorAll(sel))) {
      const r = el.getBoundingClientRect();
      if (r.height > 0 && r.bottom > top && r.top < (top + bottom) / 2) top = r.bottom;
    }
  }
  const l = lead?.getBoundingClientRect();
  const t = scope.getBoundingClientRect();
  if (l && l.left < t.right && l.right > t.left && l.bottom > top) top = l.bottom;
  return { top, bottom: Math.min(bottom, window.innerHeight) };
}

/**
 * SMA-36: the slow scroll while the audio plays. The marks only say where each paragraph starts,
 * so the reading position inside the live paragraph is estimated from the time between its mark
 * and the next; while following, the text eases so that estimated line sits on the reading line.
 * Nothing is highlighted from the estimate (owner: not until there is true word tracking).
 * Returns the stop function.
 */
function startGlide(
  audio: HTMLAudioElement,
  scope: HTMLElement,
  lead: HTMLElement | null,
  listen: ListenViewModel,
  sync: ListenSync,
  paragraph: (pid: string) => HTMLElement | null,
): () => void {
  const scroller = scrollerOf(scope);
  let raf = 0;
  let last = 0;
  let glideY: number | null = null; // fractional scroll position (scrolling rounds to whole px)

  function frame(now: number) {
    const dt = last ? Math.min(100, now - last) : 16;
    last = now;
    const p = paragraphProgress(listen.marks, audio.currentTime * 1000, listen.durationMs);
    const el = p ? paragraph(p.pid) : null;
    if (!p || !el || !sync.following()) {
      glideY = null;
      return;
    }
    const r = el.getBoundingClientRect();
    const lineY = r.top + r.height * p.fraction;
    const band = readingBand(scroller, lead, scope);
    const y = scroller.y();
    const target = Math.min(scrollTargetFor(y, lineY, band.top, band.bottom), Math.max(0, scroller.max()));
    // someone else moved the text (a seek's jump, a resize): glide on from where it is now
    if (glideY === null || Math.abs(glideY - y) > 2) glideY = y;
    glideY = glideStep(glideY, target, dt);
    if (Math.abs(glideY - y) >= 0.5) scroller.set(glideY);
  }

  function loop(now: number) {
    frame(now);
    raf = window.requestAnimationFrame(loop);
  }
  function start() {
    if (raf) return;
    last = 0;
    raf = window.requestAnimationFrame(loop);
  }
  function halt() {
    window.cancelAnimationFrame(raf);
    raf = 0;
    glideY = null;
  }

  audio.addEventListener('play', start);
  audio.addEventListener('playing', start);
  audio.addEventListener('pause', halt);
  audio.addEventListener('ended', halt);
  if (!audio.paused) start();

  return () => {
    halt();
    audio.removeEventListener('play', start);
    audio.removeEventListener('playing', start);
    audio.removeEventListener('pause', halt);
    audio.removeEventListener('ended', halt);
  };
}
