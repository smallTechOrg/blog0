// The page typewriter (owner decision, UI review 2026-10-20): on Home, Archive and About the whole
// page — every visible character, field placeholder, line, box, image and icon — prints in one
// sequence, left to right and top to bottom, at one constant speed. Everything is in the DOM from
// the first frame and nothing reflows. Text: the not-yet-typed tail is painted transparent through
// the CSS Custom Highlight API (`::highlight(blog0-untyped)` in additions.css), so React's DOM is
// never touched. A placeholder is rewritten, then put back whole. Ink (an element's own borders,
// background, shadow, backdrop blur, or a replaced element: image, icon, canvas) carries `data-ink="0"` until its
// turn, then draws in — lines and boxes left to right, images and icons top to bottom — and the
// attribute comes off. Anything that appears after the page loads is not held back. Without the
// Highlight API, or with reduced motion, the page is simply complete.

/** One character every TYPE_CHAR_MS, everywhere on the page. */
export const TYPE_CHAR_MS = 10;
export const HIGHLIGHT_NAME = 'blog0-untyped';

/** Skipped: screen-reader-only copies and anything not rendered. */
const SKIP_SELECTOR = '.sr, script, style, noscript, template, [hidden]';

/** Number of characters that cost typing time (whitespace is free: it has no glyph). */
export function weight(text: string): number {
  return text.replace(/\s+/g, '').length;
}

/** Where the untyped tail starts once `n` characters have landed: the text's index and the offset
 *  inside it, or null when every character has landed. */
export function cursorAt(texts: readonly string[], n: number): { index: number; offset: number } | null {
  let left = Math.max(0, Math.floor(n));
  for (let index = 0; index < texts.length; index++) {
    const t = texts[index];
    const w = weight(t);
    if (left >= w) {
      left -= w;
      continue;
    }
    for (let offset = 0; offset < t.length; offset++) {
      if (/\s/.test(t[offset])) continue;
      if (left === 0) return { index, offset };
      left -= 1;
    }
  }
  return null;
}

/** Inside a `[data-type-visual]` block (the masthead, whose grid moves the wordmark above or
 *  beside the tabs by width) things print in on-screen order: row by row, then left to right. */
const VISUAL_SELECTOR = '[data-type-visual]';

/** How ink draws in: `line` wipes left to right (borders, rules, boxes), `scan` top to bottom
 *  (images, icons, canvases). Its turn costs as much time as this many characters. */
export type InkMode = 'line' | 'scan';
export const INK_WEIGHT: Record<InkMode, number> = { line: 3, scan: 6 };
/** Matches the reveal animations in additions.css; the attribute comes off after this. */
export const INK_MS: Record<InkMode, number> = { line: 180, scan: 320 };

/** What prints: a text node, a field's placeholder, or an element's own ink. */
export type TypedItem =
  | { kind: 'text'; node: Text }
  | { kind: 'field'; el: HTMLInputElement | HTMLTextAreaElement; full: string }
  | { kind: 'ink'; el: Element; mode: InkMode };

/** Stands in for an item's cost in `cursorAt`: its text, or `x` per ink character. */
function costText(it: TypedItem): string {
  return it.kind === 'text' ? it.node.data : it.kind === 'field' ? it.full : 'x'.repeat(INK_WEIGHT[it.mode]);
}

function elOf(it: TypedItem): Element {
  return it.kind === 'text' ? it.node.parentElement! : it.el;
}

function rectOf(it: TypedItem): DOMRect {
  if (it.kind !== 'text') return it.el.getBoundingClientRect();
  const r = document.createRange();
  r.selectNodeContents(it.node);
  return r.getBoundingClientRect();
}

/** A colour that paints (not `transparent`, not zero alpha). */
export function paints(c: string): boolean {
  return !!c && c !== 'transparent' && !/^rgba\([^,]+,[^,]+,[^,]+,\s*0(\.0*)?\)$/.test(c) && !/\/\s*0(\.0*)?\)$/.test(c);
}

const REPLACED = new Set(['IMG', 'SVG', 'svg', 'CANVAS', 'VIDEO', 'IFRAME', 'PICTURE']);

/** Whether an element paints anything of its own, and how it draws in. */
export function inkMode(el: Element): InkMode | null {
  if (REPLACED.has(el.tagName)) return 'scan';
  const cs = getComputedStyle(el);
  if (cs.backgroundImage !== 'none' && cs.backgroundImage.includes('url(') && !el.textContent?.trim()) return 'scan';
  const border = (['Top', 'Right', 'Bottom', 'Left'] as const).some(
    (s) => cs.getPropertyValue(`border-${s.toLowerCase()}-width`) !== '0px' && cs.getPropertyValue(`border-${s.toLowerCase()}-style`) !== 'none' && paints(cs.getPropertyValue(`border-${s.toLowerCase()}-color`)),
  );
  if (border || paints(cs.backgroundColor) || cs.backgroundImage !== 'none' || cs.boxShadow !== 'none' || (cs.backdropFilter || 'none') !== 'none') return 'line';
  for (const pseudo of ['::before', '::after']) {
    const ps = getComputedStyle(el, pseudo);
    if (ps.content !== 'none' && ps.content !== 'normal' && (paints(ps.backgroundColor) || ps.backgroundImage !== 'none' || ps.borderTopStyle !== 'none' || ps.borderBottomStyle !== 'none')) return 'line';
  }
  return null;
}

/** The root's printable items in reading order: document order (an element's ink before its
 *  contents), except visual order inside a `[data-type-visual]` block. */
export function typedItems(root: HTMLElement): TypedItem[] {
  const out: TypedItem[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode(n) {
      if (n.nodeType !== 1) return NodeFilter.FILTER_ACCEPT;
      const el = n as Element;
      /* an icon is one item: its inner shapes are not visited */
      if (el.matches(SKIP_SELECTOR) || (el as SVGElement).ownerSVGElement) return NodeFilter.FILTER_REJECT;
      return el.getClientRects().length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === 1) {
      const el = n as Element;
      const mode = inkMode(el);
      if (mode) out.push({ kind: 'ink', el, mode });
      if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && weight(el.placeholder)) out.push({ kind: 'field', el, full: el.placeholder });
      continue;
    }
    const t = n as Text;
    if (t.parentElement && weight(t.data)) out.push({ kind: 'text', node: t });
  }
  const host = (it: TypedItem) => elOf(it).closest(VISUAL_SELECTOR);
  for (let i = 0; i < out.length; ) {
    const block = host(out[i]);
    let j = i + 1;
    while (j < out.length && block && host(out[j]) === block) j++;
    if (block && j - i > 1) {
      const keyed = out.slice(i, j).map((t) => ({ t, b: rectOf(t) }));
      /* same row when the vertical centres are within half a line; a box before what it holds */
      keyed.sort((x, y) => {
        if (x.t.kind === 'ink' && elOf(y.t) !== x.t.el && x.t.el.contains(elOf(y.t))) return -1;
        if (y.t.kind === 'ink' && elOf(x.t) !== y.t.el && y.t.el.contains(elOf(x.t))) return 1;
        const dy = x.b.top + x.b.height / 2 - (y.b.top + y.b.height / 2);
        return Math.abs(dy) > Math.min(x.b.height, y.b.height) / 2 ? dy : x.b.left - y.b.left;
      });
      out.splice(i, j - i, ...keyed.map((k) => k.t));
    }
    i = j;
  }
  return out;
}

type HighlightSet = { add(r: Range): void; delete(r: Range): void };
type HighlightRegistry = { set(name: string, h: HighlightSet): void; delete(name: string): void };

function registry(): { reg: HighlightRegistry; Highlight: new (...r: Range[]) => HighlightSet } | null {
  const w = window as unknown as { CSS?: { highlights?: HighlightRegistry }; Highlight?: new (...r: Range[]) => HighlightSet };
  return w.CSS?.highlights && w.Highlight ? { reg: w.CSS.highlights, Highlight: w.Highlight } : null;
}

/* Scrolling down (owner, UI review 2026-10-20): while the reader scrolls down, typing runs
   SCROLL_SPEEDUP times faster; if the typing point has scrolled above the visible window,
   everything above the window lands at once and typing carries on from the window's first line.
   Scrolling up changes nothing. */
export const SCROLL_SPEEDUP = 4;
/** A scroll-down counts as "scrolling" for this long after its last event. */
export const SCROLL_HOLD_MS = 180;

/** Index of the first text at or after `from` whose box reaches below `top` (the window's top
 *  edge under the sticky masthead), or `bottoms.length` when none does. */
export function firstVisible(bottoms: (i: number) => number, from: number, count: number, top: number): number {
  let i = from;
  while (i < count && bottoms(i) <= top) i++;
  return i;
}

export interface TypePageOptions {
  /** The visible window's top edge in viewport px (e.g. the sticky masthead's bottom). */
  windowTop?: () => number;
  /** A pinned block (the sticky masthead): always in view, so it is never skipped as read — it
   *  types first, and any skip ahead happens once the typing has left it. */
  pinned?: Element | null;
}

/** Types `root` in from the first character. Returns a stop function that leaves it complete.
 *  Scrolling never interrupts it; scrolling down speeds it up or skips it ahead (above). */
export function typePage(root: HTMLElement, opts: TypePageOptions = {}): () => void {
  const api = registry();
  if (!api) return () => {};
  const items = typedItems(root);
  const texts = items.map(costText);
  if (!cursorAt(texts, 0)) return () => {};
  const { reg } = api;
  /* characters before each item, for skipping ahead */
  const before: number[] = [];
  const total = texts.reduce((n, t, i) => ((before[i] = n), n + weight(t)), 0);
  /* one range per untyped text (the one being typed: over its untyped tail) */
  const ranges = items.map((it) => {
    if (it.kind !== 'text') return null;
    const r = document.createRange();
    r.selectNodeContents(it.node);
    return r;
  });
  const hl = new api.Highlight(...ranges.filter((r): r is Range => r !== null));
  reg.set(HIGHLIGHT_NAME, hl);
  items.forEach((it) => {
    if (it.kind === 'field') it.el.placeholder = '';
    else if (it.kind === 'ink') it.el.setAttribute('data-ink', '0');
  });
  const timers = new Set<number>();
  let typed = 0; // characters landed (fractional)
  let last = performance.now();
  let lastY = window.scrollY;
  let downAt = -Infinity; // last scroll-down event
  /* the first frames also skip ahead (no speed-up) once the pinned masthead has typed: a reload
     keeps the reader's scroll position, and what is above the window counts as read */
  let first = true;
  const isPinned = (i: number) => !!opts.pinned && opts.pinned.contains(elOf(items[i]));
  let done = 0; // items fully reached
  let raf = 0;
  let stopped = false;

  /** The cursor reached item i: it lands (ink starts drawing in). */
  function reach(i: number) {
    const it = items[i];
    if (it.kind === 'text') hl.delete(ranges[i]!);
    else if (it.kind === 'field') it.el.placeholder = it.full;
    else if (it.el.getAttribute('data-ink') === '0') {
      it.el.setAttribute('data-ink', it.mode);
      const t = window.setTimeout(() => {
        timers.delete(t);
        it.el.removeAttribute('data-ink');
      }, INK_MS[it.mode]);
      timers.add(t);
    }
  }

  /** Item i is complete at once (skipped past, or typing stopped). */
  function finish(i: number) {
    const it = items[i];
    if (it.kind === 'ink') it.el.removeAttribute('data-ink');
    else reach(i);
  }

  function onScroll() {
    const y = window.scrollY;
    if (y > lastY) downAt = performance.now();
    lastY = y;
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    window.cancelAnimationFrame(raf);
    window.removeEventListener('scroll', onScroll);
    timers.forEach((t) => window.clearTimeout(t));
    reg.delete(HIGHLIGHT_NAME);
    items.forEach((_, i) => finish(i));
  }

  function tick() {
    if (stopped) return;
    const now = performance.now();
    let rate = 1;
    const scrolling = now - downAt < SCROLL_HOLD_MS;
    if (scrolling || first) {
      const at = cursorAt(texts, typed);
      if (at) {
        const top = Math.max(0, opts.windowTop?.() ?? 0);
        /* a text counts as read once its bottom is above the window; ink (a box, rule or image)
           once its top is — what it holds is then judged on its own */
        const bottomOf = (i: number) => {
          if (isPinned(i)) return Infinity;
          const r = i === at.index && ranges[i] ? ranges[i].getBoundingClientRect() : rectOf(items[i]);
          return items[i].kind === 'ink' ? r.top : r.bottom;
        };
        const i = firstVisible(bottomOf, at.index, items.length, top);
        if (i > at.index) {
          for (; done < i; done++) finish(done);
          typed = before[i] ?? total;
        } else if (scrolling) rate = SCROLL_SPEEDUP;
        if (!isPinned(at.index)) first = false;
      } else first = false;
    }
    typed += ((now - last) / TYPE_CHAR_MS) * rate;
    last = now;
    const at = cursorAt(texts, typed);
    if (!at) {
      for (; done < items.length; done++) reach(done);
      /* let the last ink finish drawing; the timers take the attributes off */
      window.cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll);
      reg.delete(HIGHLIGHT_NAME);
      return;
    }
    for (; done < at.index; done++) reach(done);
    const it = items[at.index];
    if (it.kind === 'field') it.el.placeholder = it.full.slice(0, at.offset);
    else if (it.kind === 'ink') reach(at.index);
    else if (it.node.isConnected && ranges[at.index]!.startOffset !== at.offset) {
      hl.delete(ranges[at.index]!);
      const r = document.createRange();
      r.setStart(it.node, at.offset);
      r.setEnd(it.node, it.node.length);
      ranges[at.index] = r;
      hl.add(r);
    }
    raf = window.requestAnimationFrame(tick);
  }

  raf = window.requestAnimationFrame(tick);
  window.addEventListener('scroll', onScroll, { passive: true });
  return stop;
}
