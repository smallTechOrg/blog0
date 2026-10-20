// The page typewriter (owner decision, UI review 2026-10-20): on Home, Archive and About every
// visible character of the page — masthead, tabs, featured, latest, footer, field placeholders —
// types in one sequence, left to right and top to bottom, at one constant speed. The text is in
// the DOM from the first frame; only the not-yet-typed tail is painted transparent, through the
// CSS Custom Highlight API (`::highlight(blog0-untyped)` in additions.css), so React's DOM is
// never touched and nothing reflows (a placeholder is rewritten, then put back whole). Text that appears after the page loads is not held back. Without that
// API, or with reduced motion, the page is simply complete.

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
 *  beside the tabs by width) text types in on-screen order: row by row, then left to right. */
const VISUAL_SELECTOR = '[data-type-visual]';

/** What types: a text node, or a field's placeholder (typed by rewriting the attribute). */
export type TypedItem = Text | HTMLInputElement | HTMLTextAreaElement;

function isText(it: TypedItem): it is Text {
  return it.nodeType === 3;
}

function rectOf(it: TypedItem): DOMRect {
  if (!isText(it)) return it.getBoundingClientRect();
  const r = document.createRange();
  r.selectNodeContents(it);
  return r.getBoundingClientRect();
}

/** The root's rendered texts and field placeholders in reading order: document order, except
 *  visual order inside a `[data-type-visual]` block. */
export function typedItems(root: HTMLElement): TypedItem[] {
  const out: TypedItem[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === 1) {
      const f = n as HTMLElement;
      if ((f instanceof HTMLInputElement || f instanceof HTMLTextAreaElement) && weight(f.placeholder) && !f.closest(SKIP_SELECTOR) && f.getClientRects().length) out.push(f);
      continue;
    }
    const t = n as Text;
    const el = t.parentElement;
    if (!el || !weight(t.data) || el.closest(SKIP_SELECTOR) || el.getClientRects().length === 0) continue;
    out.push(t);
  }
  const host = (it: TypedItem) => (isText(it) ? it.parentElement! : it).closest(VISUAL_SELECTOR);
  for (let i = 0; i < out.length; ) {
    const block = host(out[i]);
    let j = i + 1;
    while (j < out.length && block && host(out[j]) === block) j++;
    if (block && j - i > 1) {
      const keyed = out.slice(i, j).map((t) => ({ t, b: rectOf(t) }));
      /* same row when the vertical centres are within half a line */
      keyed.sort((x, y) => {
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
}

/** Types `root` in from the first character. Returns a stop function that leaves it complete.
 *  Scrolling never interrupts it; scrolling down speeds it up or skips it ahead (above). */
export function typePage(root: HTMLElement, opts: TypePageOptions = {}): () => void {
  const api = registry();
  if (!api) return () => {};
  const items = typedItems(root);
  const texts = items.map((it) => (isText(it) ? it.data : it.placeholder));
  if (!cursorAt(texts, 0)) return () => {};
  const { reg } = api;
  /* characters before each item, for skipping ahead */
  const before: number[] = [];
  const total = texts.reduce((n, t, i) => ((before[i] = n), n + weight(t)), 0);
  /* one range per untyped text (the one being typed: over its untyped tail); a placeholder is
     typed by rewriting it, and put back whole when typing stops */
  const ranges = items.map((it) => {
    if (!isText(it)) return null;
    const r = document.createRange();
    r.selectNodeContents(it);
    return r;
  });
  const hl = new api.Highlight(...ranges.filter((r): r is Range => r !== null));
  reg.set(HIGHLIGHT_NAME, hl);
  items.forEach((it) => {
    if (!isText(it)) it.placeholder = '';
  });
  let typed = 0; // characters landed (fractional)
  let last = performance.now();
  let lastY = window.scrollY;
  let downAt = -Infinity; // last scroll-down event
  /* the first frame also skips ahead (no speed-up): a reload keeps the reader's scroll position,
     and the text above the window counts as read */
  let first = true;
  let done = 0; // items fully typed
  let raf = 0;
  let stopped = false;

  function land(i: number) {
    const it = items[i];
    if (isText(it)) hl.delete(ranges[i]!);
    else it.placeholder = texts[i];
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
    reg.delete(HIGHLIGHT_NAME);
    for (; done < items.length; done++) land(done);
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
        const bottomOf = (i: number) => (i === at.index && ranges[i] ? ranges[i].getBoundingClientRect() : rectOf(items[i])).bottom;
        const i = firstVisible(bottomOf, at.index, items.length, top);
        if (i > at.index) typed = before[i] ?? total;
        else if (scrolling) rate = SCROLL_SPEEDUP;
      }
      first = false;
    }
    typed += ((now - last) / TYPE_CHAR_MS) * rate;
    last = now;
    const at = cursorAt(texts, typed);
    if (!at) return stop();
    for (; done < at.index; done++) land(done);
    const it = items[at.index];
    if (!isText(it)) it.placeholder = texts[at.index].slice(0, at.offset);
    else if (it.isConnected && ranges[at.index]!.startOffset !== at.offset) {
      hl.delete(ranges[at.index]!);
      const r = document.createRange();
      r.setStart(it, at.offset);
      r.setEnd(it, it.length);
      ranges[at.index] = r;
      hl.add(r);
    }
    raf = window.requestAnimationFrame(tick);
  }

  raf = window.requestAnimationFrame(tick);
  window.addEventListener('scroll', onScroll, { passive: true });
  return stop;
}
