// The page typewriter (owner decision, UI review 2026-10-20): on Home, Archive and About every
// visible character of the page — masthead, tabs, featured, latest, footer — types in one
// sequence, left to right and top to bottom, at one constant speed. The text is in the DOM from
// the first frame; only the not-yet-typed tail is painted transparent, through the CSS Custom
// Highlight API (`::highlight(blog0-untyped)` in additions.css), so React's DOM is never touched
// and nothing reflows. Text that appears after the page loads is not held back. Without that
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

function box(t: Text): DOMRect {
  const r = document.createRange();
  r.selectNodeContents(t);
  return r.getBoundingClientRect();
}

/** The root's rendered text nodes in reading order: document order, except visual order inside
 *  a `[data-type-visual]` block. */
export function typedTextNodes(root: HTMLElement): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    const el = t.parentElement;
    if (!el || !weight(t.data) || el.closest(SKIP_SELECTOR) || el.getClientRects().length === 0) continue;
    out.push(t);
  }
  for (let i = 0; i < out.length; ) {
    const block = out[i].parentElement!.closest(VISUAL_SELECTOR);
    let j = i + 1;
    while (j < out.length && block && out[j].parentElement!.closest(VISUAL_SELECTOR) === block) j++;
    if (block && j - i > 1) {
      const keyed = out.slice(i, j).map((t) => ({ t, b: box(t) }));
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

/** Types `root` in from the first character. Returns a stop function that leaves it complete.
 *  Scrolling does not interrupt it (owner, UI review 2026-10-20). */
export function typePage(root: HTMLElement): () => void {
  const api = registry();
  if (!api) return () => {};
  const nodes = typedTextNodes(root);
  const texts = nodes.map((t) => t.data);
  if (!cursorAt(texts, 0)) return () => {};
  const { reg } = api;
  /* one range per untyped text; the text being typed has a range over its untyped tail */
  const ranges = nodes.map((t) => {
    const r = document.createRange();
    r.selectNodeContents(t);
    return r;
  });
  const hl = new api.Highlight(...ranges);
  reg.set(HIGHLIGHT_NAME, hl);
  const t0 = performance.now();
  let done = 0; // texts fully typed
  let raf = 0;
  let stopped = false;

  function stop() {
    if (stopped) return;
    stopped = true;
    window.cancelAnimationFrame(raf);
    reg.delete(HIGHLIGHT_NAME);
  }

  function tick() {
    if (stopped) return;
    const at = cursorAt(texts, (performance.now() - t0) / TYPE_CHAR_MS);
    if (!at) return stop();
    for (; done < at.index; done++) hl.delete(ranges[done]);
    if (nodes[at.index].isConnected && ranges[at.index].startOffset !== at.offset) {
      hl.delete(ranges[at.index]);
      const r = document.createRange();
      r.setStart(nodes[at.index], at.offset);
      r.setEnd(nodes[at.index], nodes[at.index].length);
      ranges[at.index] = r;
      hl.add(r);
    }
    raf = window.requestAnimationFrame(tick);
  }

  raf = window.requestAnimationFrame(tick);
  return stop;
}
