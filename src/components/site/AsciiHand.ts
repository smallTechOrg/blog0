// Footer motion hooks, ported from spec/design/design-app.js (useAsciiHand, useEof).
import { useEffect, type RefObject } from 'react';

import { prefersReducedMotion } from '@/components/design/motion';

/* ------------------------------------------------------------------
   ASCII field — characters rasterised to a grid on a canvas behind the
   footer. Cells flicker slowly; the pointer brightens and scrambles what
   it passes over. Honors reduced motion.
   ------------------------------------------------------------------ */
export const FT_CH = '#&%{}[]§"/*|()01';
export const FT_CW = 10;
export const FT_CHT = 17;

export function ftHash(a: number, b: number): number {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/* The design names "JetBrains Mono" literally; next/font hashes the family name, so the
   canvas reads the resolved --font-mono stack instead (divergence 23). */
function monoFamily(el: Element): string {
  const v = getComputedStyle(el).getPropertyValue('--font-mono').trim();
  return v || '"JetBrains Mono", monospace';
}

interface Cell {
  x: number;
  y: number;
  cov: number;
  ch: string;
  ph: number;
}

export function useAsciiHand(footRef: RefObject<HTMLElement | null>, cvRef: RefObject<HTMLCanvasElement | null>): void {
  useEffect(() => {
    const foot = footRef.current;
    const cv = cvRef.current;
    if (!foot || !cv || !cv.getContext) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const reduce = prefersReducedMotion();
    let cells: Cell[] = [];
    let W = 0;
    let H = 0;
    let px = -999;
    let py = -999;
    let run = false;
    let last = 0;
    let raf = 0;
    let font = '12px ' + monoFamily(foot);

    function build() {
      W = foot!.clientWidth;
      H = foot!.clientHeight;
      if (!W || !H) return;
      font = '12px ' + monoFamily(foot!);
      const d = Math.min(window.devicePixelRatio || 1, 2);
      cv!.width = W * d;
      cv!.height = H * d;
      ctx!.setTransform(d, 0, 0, d, 0, 0);
      const cols = Math.ceil(W / FT_CW);
      const rows = Math.ceil(H / FT_CHT);
      /* No figure any more: a random scatter of characters across the whole
         band, seeded per cell so it is stable between frames and resizes.
         Slightly denser toward the right, where there is less text to fight. */
      cells = [];
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
          const nn = ftHash(c, r);
          const bias = 0.8 - (c / cols) * 0.1; /* 0.80 at the left edge, 0.70 at the right */
          if (nn < bias) continue;
          const cov = 0.12 + ((nn - bias) / (1 - bias)) * 0.7;
          cells.push({
            x: c * FT_CW,
            y: r * FT_CHT + FT_CHT - 4,
            cov,
            ch: FT_CH[((nn * 997) | 0) % FT_CH.length],
            ph: nn * 6.28,
          });
        }
      draw(0);
    }
    function draw(t: number) {
      ctx!.clearRect(0, 0, W, H);
      ctx!.font = font;
      ctx!.fillStyle = '#BF8938';
      for (let i = 0; i < cells.length; i++) {
        const k = cells[i];
        /* kept faint: texture behind the type, not competing with it */
        let al = 0.03 + k.cov * 0.12;
        if (!reduce) al *= 0.8 + 0.2 * Math.sin(t * 0.0009 + k.ph);
        const dist = Math.hypot(k.x - px, k.y - py);
        if (dist < 120) {
          const bb = 1 - dist / 120;
          al = Math.max(al, bb * 0.5);
          if (!reduce && Math.random() < 0.25 * bb) k.ch = FT_CH[(Math.random() * FT_CH.length) | 0];
        }
        ctx!.globalAlpha = al;
        ctx!.fillText(k.ch, k.x, k.y);
      }
      ctx!.globalAlpha = 1;
    }
    function loop(t: number) {
      if (!run) return;
      if (t - last > 80) {
        last = t;
        for (let i = 0; i < 24; i++) {
          const k = cells[(Math.random() * cells.length) | 0];
          if (k) k.ch = FT_CH[(Math.random() * FT_CH.length) | 0];
        }
        draw(t);
      }
      raf = window.requestAnimationFrame(loop);
    }
    build();
    let rt: number | undefined;
    function onResize() {
      window.clearTimeout(rt);
      rt = window.setTimeout(build, 150);
    }
    window.addEventListener('resize', onResize);
    if (document.fonts && document.fonts.ready) void document.fonts.ready.then(build);
    function onMove(e: PointerEvent) {
      const r = foot!.getBoundingClientRect();
      px = e.clientX - r.left;
      py = e.clientY - r.top;
    }
    function onLeave() {
      px = py = -999;
    }
    if (!reduce) {
      foot.addEventListener('pointermove', onMove);
      foot.addEventListener('pointerleave', onLeave);
    }
    let io: IntersectionObserver | null = null;
    if ('IntersectionObserver' in window) {
      io = new IntersectionObserver(
        (es) => {
          const on = es.some((e) => e.isIntersecting);
          if (on) cv.classList.add('is-on');
          const was = run;
          run = on && !reduce;
          if (run && !was) raf = window.requestAnimationFrame(loop);
        },
        { threshold: 0.2 },
      );
      io.observe(foot);
    } else {
      cv.classList.add('is-on');
    }
    return () => {
      run = false;
      if (raf) window.cancelAnimationFrame(raf);
      window.clearTimeout(rt);
      window.removeEventListener('resize', onResize);
      foot.removeEventListener('pointermove', onMove);
      foot.removeEventListener('pointerleave', onLeave);
      if (io) io.disconnect();
    };
  }, [footRef, cvRef]);
}

/* "> end of <wordmark>" types itself in once the footer is on screen */
export function useEof(
  footRef: RefObject<HTMLElement | null>,
  eofRef: RefObject<HTMLElement | null>,
  wordmark: string,
): void {
  useEffect(() => {
    const foot = footRef.current;
    const el = eofRef.current;
    if (!foot || !el) return;
    const line = '> end of ' + wordmark;
    let started = false;
    let t: number | undefined;
    function type() {
      if (started) return;
      started = true;
      if (prefersReducedMotion()) {
        el!.textContent = line;
        return;
      }
      let i = 0;
      t = window.setInterval(() => {
        el!.textContent = line.slice(0, ++i);
        if (i >= line.length) window.clearInterval(t);
      }, 45);
    }
    let io: IntersectionObserver | null = null;
    if ('IntersectionObserver' in window) {
      io = new IntersectionObserver(
        (es) => {
          if (es.some((e) => e.isIntersecting)) type();
        },
        { threshold: 0.2 },
      );
      io.observe(foot);
    } else type();
    return () => {
      window.clearInterval(t);
      if (io) io.disconnect();
    };
  }, [footRef, eofRef, wordmark]);
}
