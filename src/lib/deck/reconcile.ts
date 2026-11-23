// SMA-52: a TLDR slide is its sentence's TEXT. Editing the article moves sentences around (a sentence id
// is the paragraph's hash + its position, so editing one sentence changes the id of every sentence in
// that paragraph, and adding a paragraph shifts nothing but adds lines). A slide must therefore only go
// "missing" when its exact text is no longer anywhere in the article — never because its id changed.
// Pure + isomorphic: the server rebases a saved deck on every new revision, the editor reuses it.

export interface DeckSlideLike {
  sid: string;
  text: string;
  /** An image slide is not a sentence of the article: it is never matched or missing. */
  image?: unknown;
}

export interface LineLike {
  sid: string;
  text: string;
}

export interface Reconciled<S extends DeckSlideLike> {
  /** Every slide, in the deck's order; a re-attached slide carries its sentence's current sid. */
  slides: S[];
  /** sids (as in `slides`) of slides whose text is no longer in the article. */
  missing: string[];
  /** True when at least one slide got a different sid. */
  rebased: boolean;
}

/**
 * Re-attaches each text slide to the current line with the same text: the slide's own sid when that
 * line still exists (an unchanged slide is returned untouched), otherwise the first not-yet-used line
 * with that exact text, in article order. Two slides never share a line.
 */
export function reconcileSlides<S extends DeckSlideLike>(slides: readonly S[], lines: readonly LineLike[]): Reconciled<S> {
  const bySid = new Map(lines.map((l) => [l.sid, l.text]));
  const used = new Set<string>();
  const attached = new Set<number>(); // indexes of slides that sit on a line now
  // pass 1: a slide whose own sid still carries its text keeps it (so duplicates stay where they were)
  slides.forEach((s, i) => {
    if (s.image || bySid.get(s.sid) === s.text) {
      attached.add(i);
      if (!s.image) used.add(s.sid);
    }
  });

  // pass 2: the rest take the first free line with exactly their text
  let rebased = false;
  const out: S[] = slides.map((s, i) => {
    if (attached.has(i)) return s;
    const hit = lines.find((l) => l.text === s.text && !used.has(l.sid));
    if (!hit) return s;
    used.add(hit.sid);
    attached.add(i);
    rebased = true;
    return { ...s, sid: hit.sid };
  });

  // What is left has no sentence any more. Its old sid may now belong to another slide's sentence:
  // give it a sid of its own so every slide stays individually addressable (remove, move).
  const taken = new Set(out.filter((_, i) => attached.has(i)).map((s) => s.sid));
  const missing: string[] = [];
  const final = out.map((s, i) => {
    if (attached.has(i)) return s;
    let sid = s.sid;
    while (taken.has(sid)) sid += '~gone';
    taken.add(sid);
    missing.push(sid);
    if (sid === s.sid) return s;
    rebased = true;
    return { ...s, sid };
  });
  return { slides: final, missing, rebased };
}
