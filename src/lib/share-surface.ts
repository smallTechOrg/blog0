// Where a share goes and where its menu sits — pure decisions behind the reader's share
// components (spec/ui.md §3 "Share", spec/capabilities/paragraph-share.md "Business Rules").

/** Viewports narrower than this count as "narrow" (phones, small tablets in portrait). */
export const NARROW_PX = 720;

/** Menu width and edge padding, from the design's `placeFor` (.hlmenu is 272 px wide). */
export const MENU_W = 272;
const PAD = 12;

export interface ShareEnv {
  /** `typeof navigator.share === 'function'` */
  hasShare: boolean;
  /** `matchMedia('(pointer: coarse)').matches` */
  coarsePointer: boolean;
  /** `window.innerWidth` */
  viewportWidth: number;
}

/** Touch or narrow screens with a native share sheet use it; everything else gets the menu. */
export function prefersNativeShare(env: ShareEnv): boolean {
  return env.hasShare && (env.coarsePointer || env.viewportWidth < NARROW_PX);
}

/** After `navigator.share` rejects: a dismissed sheet (`AbortError`) ends the share; any other
 *  failure falls back to the menu. */
export function nativeShareFallback(err: unknown): 'none' | 'menu' {
  const name = err && typeof err === 'object' && 'name' in err ? (err as { name?: unknown }).name : undefined;
  return name === 'AbortError' ? 'none' : 'menu';
}

const PID_HASH = /^#(p-[0-9a-f]{8}(?:-\d+)?)$/;

/** The paragraph id in a `#p-xxxxxxxx` (or duplicate-suffixed `#p-xxxxxxxx-2`) fragment. */
export function paragraphIdFromHash(hash: string): string | null {
  const m = PID_HASH.exec(hash);
  return m ? m[1] : null;
}

export interface RectLike {
  left: number;
  top: number;
  bottom: number;
}

/** The design's `placeFor`: 10 px under the last line rect `r`, clamped to the viewport;
 *  flipped above the first line when the menu (≈230 px) would run off the bottom. */
export function menuPlacement(
  rects: ArrayLike<RectLike>,
  r: RectLike,
  viewport: { width: number; height: number },
): { x: number; y: number } {
  const x = Math.max(PAD, Math.min(r.left, viewport.width - MENU_W - PAD));
  const below = r.bottom + 10;
  const first = rects.length ? rects[0] : r;
  const y = below + 230 > viewport.height ? Math.max(PAD, first.top - 236) : below;
  return { x, y };
}

const INTERACTIVE = new Set(['a', 'button', 'input', 'textarea', 'select', 'label', 'summary', 'figure', 'video', 'audio']);

/** True when a click inside a paragraph landed on something interactive. `path` is the
 *  lower-cased tag names from the click target up to the paragraph element. */
export function shareClickIgnored(path: ReadonlyArray<string>): boolean {
  return path.some((t) => INTERACTIVE.has(t));
}
