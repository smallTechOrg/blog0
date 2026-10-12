'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

import { Icon } from '@/components/design/Icon';
import { cx, useReducedMotion } from '@/components/design/motion';
import {
  TDECK_LAYOUT,
  TDECK_STEP_MS,
  TDECK_SWIPE,
  TDECK_WHEEL,
  tdeckSlide,
  tldrDwell,
  tldrType,
  type DeckLayout,
  type DeckSlide,
} from '@/lib/deck/timing';

import { ShareLinkButton } from './ShareLinkButton';

/* ============================================================
   TL;DR deck — the summary as a full-viewport horizontal story
   ------------------------------------------------------------
   A wheel or trackpad gesture drives horizontal progression: deltas
   accumulate until they clear a threshold, then one eased step fires
   and a short lock keeps a single flick from skipping three slides.
   Touch drags the track directly and snaps on release. Both ends
   rubber-band instead of dead-stopping.
   ============================================================ */

export interface TldrDeckProps {
  /** The whole deck, intro title card first — build it with `buildDeckSlides(title, dek, lines)`. */
  slides: DeckSlide[];
  /** Article title (running head + dialog label). */
  title: string;
  /** Eyebrow parts on the intro slide, joined with " · " — the topic … */
  tag?: string;
  /** … and "<date> · N min read". */
  meta?: string;
  /** AI disclosure printed under the intro slide (divergence 8); omitted when empty. */
  disclosure?: string | null;
  /** Absolute deck link the end slide's Share copies (…/p/<slug>/tldr). Defaults to the current URL. */
  shareLink?: string;
  /** Minutes shown in the deck's own capsule; `listen: null` shows "—". */
  times: { read: number; tldr: number; listen: number | null };
  /** X, Escape. */
  onClose: () => void;
  /** "Read the full article" + the capsule's Read; omitted → the end button is hidden and Read disabled. */
  onRead?: () => void;
  /** Capsule Listen; omitted → disabled with "Audio is not recorded yet". */
  onListen?: () => void;
  layout?: DeckLayout;
}

type TouchState = { x: number; y: number; axis: 'x' | 'y' | null; w: number; last?: number };

export function TldrDeck(props: TldrDeckProps) {
  const { slides, title, times, onClose, onRead, onListen } = props;
  const n = slides.length;
  const [idx, setIdx] = useState(0);
  /* auto-advance runs until the reader takes over or the deck ends */
  const [playing, setPlaying] = useState(true);
  const [drag, setDrag] = useState(0); /* live drag, in % of a slide */
  const [animating, setAnimating] = useState(true);

  const idxRef = useRef(0);
  const lockRef = useRef(false);
  const accRef = useRef(0);
  const touchRef = useRef<TouchState | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const slidesRef = useRef(slides);
  const reduce = useReducedMotion();
  const reduceRef = useRef(reduce);

  useLayoutEffect(() => {
    idxRef.current = idx;
    onCloseRef.current = onClose;
    slidesRef.current = slides;
    reduceRef.current = reduce;
  });

  /* The deck starts where the site header ends, so the header stays in view.
     Measured rather than assumed: the header is taller before it compacts. */
  const [headTop, setHeadTop] = useState(0);
  useLayoutEffect(() => {
    function measure() {
      const el = document.querySelector('.sitehead');
      setHeadTop(el ? Math.max(0, Math.round(el.getBoundingClientRect().bottom)) : 0);
    }
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  const goTo = useCallback(
    (next: number): boolean => {
      const clamped = Math.max(0, Math.min(n - 1, next));
      if (clamped === idxRef.current) return false;
      idxRef.current = clamped;
      setAnimating(true);
      setIdx(clamped);
      return true;
    },
    [n],
  );

  /* One step per gesture: the lock clears after the transition, so a long
     trackpad flick advances one slide rather than running to the end. */
  const step = useCallback(
    (d: number): boolean => {
      if (lockRef.current) return false;
      const moved = goTo(idxRef.current + d);
      if (moved) {
        lockRef.current = true;
        window.setTimeout(
          () => {
            lockRef.current = false;
          },
          reduceRef.current ? 60 : TDECK_STEP_MS * 0.72,
        );
      }
      return moved;
    },
    [goTo],
  );

  /* --- auto-advance ---------------------------------------------------
     Each slide holds for about as long as it takes to read, and the bar
     across the top fills over the same span. It stops at the last slide
     rather than looping, and any manual move hands control back. */
  useEffect(() => {
    if (!playing || idx >= n - 1) return;
    const t = window.setTimeout(() => {
      lockRef.current = false;
      step(1);
    }, tldrDwell(tdeckSlide(slidesRef.current[idx])));
    return () => window.clearTimeout(t);
    // a parent re-render with a fresh (equal) slides array must not restart the dwell
  }, [idx, playing, n, step]);

  /* --- wheel: vertical scroll drives horizontal progression ----------- */
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    let settle: number | undefined;

    function onWheel(e: WheelEvent) {
      e.preventDefault(); /* the page underneath never scrolls */
      if (lockRef.current) return;
      /* trackpads send horizontal deltas too; take whichever is dominant */
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      accRef.current += d;
      if (Math.abs(accRef.current) < TDECK_WHEEL) {
        /* rubber-band at the ends so the gesture still reads as received */
        const at = idxRef.current;
        const over = (at === 0 && accRef.current < 0) || (at === n - 1 && accRef.current > 0);
        if (over && !reduceRef.current) {
          setAnimating(false);
          setDrag(Math.max(-6, Math.min(6, -accRef.current / 26)));
          window.clearTimeout(settle);
          settle = window.setTimeout(() => {
            setAnimating(true);
            setDrag(0);
            accRef.current = 0;
          }, 140);
        }
        return;
      }
      const dir = accRef.current > 0 ? 1 : -1;
      accRef.current = 0;
      setDrag(0);
      step(dir);
    }

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      window.clearTimeout(settle);
    };
  }, [n, step]);

  /* --- touch: drag the track, snap on release ------------------------- */
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;

    function onStart(e: TouchEvent) {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      touchRef.current = { x: t.clientX, y: t.clientY, axis: null, w: el!.offsetWidth || 1 };
    }
    function onMove(e: TouchEvent) {
      const st = touchRef.current;
      if (!st) return;
      const t = e.touches[0];
      const dx = t.clientX - st.x;
      const dy = t.clientY - st.y;
      if (!st.axis) {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        /* a horizontal swipe is the natural gesture here; a vertical one
           still works, so the desktop metaphor is not lost on touch */
        st.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
      }
      e.preventDefault();
      const raw = st.axis === 'x' ? dx : dy;
      let pct = (raw / st.w) * 100;
      const at = idxRef.current;
      if ((at === 0 && pct > 0) || (at === n - 1 && pct < 0)) pct *= 0.28; /* resist at the ends */
      st.last = raw;
      setAnimating(false);
      setDrag(Math.max(-100, Math.min(100, pct)));
    }
    function onEnd() {
      const st = touchRef.current;
      touchRef.current = null;
      setAnimating(true);
      setDrag(0);
      if (!st || !st.axis) return;
      const moved = st.last || 0;
      if (Math.abs(moved) > TDECK_SWIPE) {
        lockRef.current = false;
        step(moved < 0 ? 1 : -1);
      }
    }

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, [n, step]);

  /* --- keys, and the page lock underneath ----------------------------- */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown') {
        e.preventDefault();
        lockRef.current = false;
        step(1);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') {
        e.preventDefault();
        lockRef.current = false;
        step(-1);
      } else if (e.key === 'Home') {
        e.preventDefault();
        goTo(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        goTo(n - 1);
      }
    }
    document.addEventListener('keydown', onKey);

    const at = window.pageYOffset || document.documentElement.scrollTop || 0;
    const prevO = document.body.style.overflow;
    const prevR = document.documentElement.style.overscrollBehavior;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overscrollBehavior = 'none';
    if (rootRef.current) rootRef.current.focus({ preventScroll: true });

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevO;
      document.documentElement.style.overscrollBehavior = prevR;
      /* land the reader back exactly where they were */
      window.requestAnimationFrame(() => {
        const now = window.pageYOffset || document.documentElement.scrollTop || 0;
        if (Math.abs(now - at) > 2) {
          try {
            window.scrollTo({ top: at, behavior: 'auto' });
          } catch {
            window.scrollTo(0, at);
          }
        }
      });
    };
  }, [n, step, goTo]);

  if (!n) return null;
  const last = idx === n - 1;
  const live = tdeckSlide(slides[idx]);
  const dwell = tldrDwell(live);
  const layout = props.layout || TDECK_LAYOUT;
  const ease = 'cubic-bezier(.76,0,.24,1)';
  const trackStyle: CSSProperties = {
    transform: 'translate3d(' + (-idx * 100 + drag) + '%,0,0)',
    transition: animating && !reduce ? 'transform ' + TDECK_STEP_MS + 'ms ' + ease : 'none',
  };

  /* Progress, one segment per slide, the live one filling over the time
     that slide holds for. It is also the navigation — a segment can be
     clicked. It now sits at the base of the deck, above the capsule. */
  const bar = (
    <div className="tdeck__bar" role="tablist" aria-label="Summary progress">
      {slides.map((_, i) => (
        <button
          key={i}
          type="button"
          className={cx('tdeck__seg', i < idx && 'is-done', i === idx && 'is-live')}
          role="tab"
          aria-selected={i === idx ? 'true' : 'false'}
          aria-label={'Slide ' + (i + 1) + ' of ' + n}
          onClick={() => goTo(i)}
        >
          <span
            key={'f' + idx}
            className="tdeck__segfill"
            style={
              i === idx
                ? { animationDuration: dwell + 'ms', animationPlayState: playing ? 'running' : 'paused' }
                : undefined
            }
          />
        </button>
      ))}
    </div>
  );

  const eyebrow = [props.tag, props.meta].filter(Boolean).join(' · ');

  return (
    <div
      className="tdeck"
      ref={rootRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={'Summary of ' + title}
      style={{ top: headTop + 'px' }}
    >
      <div className="tdeck__scrim" />

      {/* The strip: "TL;DR | title", pause, and the X — the same strip the Read
          and Listen views carry, so the three modes read as one frame. */}
      <div className="tdeck__head">
        <p className="tdeck__runhead">
          <span className="tdeck__kick">TL;DR</span>
          {title}
        </p>
        <button
          className="tdeck__pp"
          type="button"
          aria-label={playing ? 'Pause the summary' : 'Play the summary'}
          onClick={() => setPlaying(!playing)}
        >
          {playing ? '❙❙' : '▶'}
        </button>
        <button className="tdeck__x" type="button" onClick={onClose} aria-label="Close summary">
          <Icon name="close" size={14} />
        </button>
      </div>

      <div className={cx('tdeck__next', last && 'is-off')} aria-hidden="true">
        <span>Next</span>
        <i />
      </div>

      <div className="tdeck__track" style={trackStyle}>
        {slides.map((raw, i) => {
          const sl = tdeckSlide(raw);
          /* an image, when there is one, always gets the split figure layout */
          const lay: DeckLayout = sl.img ? 'split' : layout;
          const d = i - idx;
          /* the card drifts against the track and fades off-centre */
          const cardStyle: CSSProperties = {
            transform: reduce ? 'none' : 'translate3d(' + d * 13 + '%,0,0)',
            opacity: d === 0 ? 1 : 0.08,
            transition: reduce
              ? 'none'
              : 'transform ' + TDECK_STEP_MS + 'ms ' + ease + ', opacity ' + TDECK_STEP_MS * 0.8 + 'ms ease',
          };

          /* the last slide ends on Read + Share: the summary's own link goes
             to the clipboard, so the deck can be passed on as it stands */
          const tail =
            i === n - 1 ? (
              <div key="end" className="tdeck__end">
                {onRead ? (
                  <button className="btn-outline" type="button" onClick={onRead}>
                    Read the full article
                  </button>
                ) : null}
                <ShareLinkButton link={props.shareLink} title={title} />
              </div>
            ) : null;

          /* V1 is full text or full image. The first slide is the title card. */
          let inner;
          if (sl.kind === 'intro') {
            inner = (
              <>
                <div key="i" className="tdeck__intro">
                  <p className="tdeck__eyebrow">{eyebrow}</p>
                  <h2 className="tdeck__big">{sl.text}</h2>
                  {sl.sub ? <p className="tdeck__stand">{sl.sub}</p> : null}
                  {props.disclosure ? <p className="tdeck__note">{props.disclosure}</p> : null}
                </div>
                {tail}
              </>
            );
          } else if (lay === 'split' && sl.img) {
            inner = (
              <>
                <div key="f" className="tdeck__figbox">
                  {/* eslint-disable-next-line @next/next/no-img-element -- design markup; deck art is user content */}
                  <img className="tdeck__figimg" src={sl.img} alt={sl.alt || ''} />
                </div>
                <div key="g" className="tdeck__fig">
                  <p className="tdeck__body" style={{ fontSize: tldrType(sl) }}>
                    {sl.text}
                  </p>
                  {tail}
                </div>
              </>
            );
          } else {
            /* type scales with the sentence, so a short line lands large */
            inner = (
              <>
                <p key="b" className="tdeck__body" style={{ fontSize: tldrType(sl) }}>
                  {sl.text}
                </p>
                {tail}
              </>
            );
          }

          return (
            <section key={i} className="tdeck__slide" aria-hidden={d === 0 ? 'false' : 'true'}>
              <div
                className={cx('tdeck__card', 'tdeck__card--' + (sl.kind === 'intro' ? 'intro' : lay))}
                style={cardStyle}
              >
                {inner}
              </div>
            </section>
          );
        })}
      </div>

      {bar}

      {/* The mode switcher stays reachable from inside the deck, so Read and
          Audio are one tap away without closing it first. */}
      <div className="tdeck__foot">
        <div className="modes modes--deck modes--timed" role="tablist" aria-label="How to take this in">
          <button
            className="mode"
            type="button"
            role="tab"
            aria-selected="false"
            aria-label={'Read — ' + times.read + ' min'}
            disabled={!onRead}
            onClick={() => onRead?.()}
          >
            <Icon name="text" size={14} />
            <span className="mode__t">Read</span>
            <span className="mode__d">{times.read + ' min'}</span>
          </button>
          <button
            className="mode is-on"
            type="button"
            role="tab"
            aria-selected="true"
            aria-label={'TLDR — ' + times.tldr + ' min'}
          >
            <Icon name="bolt" size={14} />
            <span className="mode__t">TLDR</span>
            <span className="mode__d">{times.tldr + ' min'}</span>
          </button>
          <button
            className="mode"
            type="button"
            role="tab"
            aria-selected="false"
            aria-label={times.listen == null ? 'Listen — coming in a later phase' : 'Listen — ' + times.listen + ' min'}
            disabled={!onListen}
            title={onListen ? undefined : 'Audio is not recorded yet'}
            onClick={() => onListen?.()}
          >
            <Icon name="headphones" size={14} />
            <span className="mode__t">Listen</span>
            <span className="mode__d">{times.listen == null ? '—' : times.listen + ' min'}</span>
          </button>
        </div>
        <span className="sr" aria-live="polite">
          {'Slide ' + (idx + 1) + ' of ' + n}
        </span>
      </div>
    </div>
  );
}
