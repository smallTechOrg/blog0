// When the writing assistant reads again (SMA-43): "every time a substantial amount of text has
// changed — a diff of about 40 words — or whenever a sentence is completed". Pure, so the rule is
// unit-tested; the hook (use-writing-assistant.ts) only adds timers and the request.
//
// The diff is one changed region: the longest common prefix and suffix of the old and new text are
// equal, everything between them changed (typing, a paste, a deletion). Its size in words is the
// larger of what was removed and what was added. A sentence counts as completed when the added text
// ends a sentence (. ! ? or …, optionally followed by a closing quote/bracket) and the change is at
// least a few words — so fixing a typo or adding a full stop does not call the model.

export const WORDS_THRESHOLD = 40;
/** A finished sentence triggers a read only when at least this many words changed since the last one. */
export const SENTENCE_MIN_WORDS = 6;
/** Wait for a pause in typing before deciding. */
export const IDLE_MS = 1500;
/** Never read more often than this. */
export const MIN_INTERVAL_MS = 15_000;
/** The excerpt sent as "changed" is cut to this. */
export const CHANGED_MAX_CHARS = 8000;

export interface ChangedRegion {
  /** [start, end) in the old text. */
  oldStart: number;
  oldEnd: number;
  /** [start, end) in the new text. */
  newStart: number;
  newEnd: number;
}

export function changedRegion(prev: string, next: string): ChangedRegion {
  let start = 0;
  const max = Math.min(prev.length, next.length);
  while (start < max && prev.charCodeAt(start) === next.charCodeAt(start)) start++;
  let endPrev = prev.length;
  let endNext = next.length;
  while (endPrev > start && endNext > start && prev.charCodeAt(endPrev - 1) === next.charCodeAt(endNext - 1)) {
    endPrev--;
    endNext--;
  }
  return { oldStart: start, oldEnd: endPrev, newStart: start, newEnd: endNext };
}

/** Whole words touched by a region: extend to word boundaries so "teh" → "the" counts one word. */
function wordsIn(text: string, start: number, end: number): number {
  if (end <= start) return 0;
  let s = start;
  let e = end;
  // A change that starts or ends inside a word takes the whole word with it.
  if (/\S/.test(text[s] ?? '')) while (s > 0 && /\S/.test(text[s - 1])) s--;
  if (/\S/.test(text[e - 1] ?? '')) while (e < text.length && /\S/.test(text[e])) e++;
  const slice = text.slice(s, e).trim();
  return slice === '' ? 0 : slice.split(/\s+/).length;
}

/** How many words changed between two versions (the larger of removed and added). */
export function changedWords(prev: string, next: string): number {
  const r = changedRegion(prev, next);
  return Math.max(wordsIn(prev, r.oldStart, r.oldEnd), wordsIn(next, r.newStart, r.newEnd));
}

const SENTENCE_END_RE = /[.!?…]["'”’)\]]*$/;

/** The added text ends a sentence. */
export function completesSentence(prev: string, next: string): boolean {
  const r = changedRegion(prev, next);
  if (r.newEnd <= r.newStart) return false;
  const added = next.slice(r.newStart, r.newEnd).trimEnd();
  // "word." typed at the end, or a pasted block whose last sentence is finished
  const upTo = next.slice(0, r.newStart + added.length).trimEnd();
  return added.length > 0 && SENTENCE_END_RE.test(upTo);
}

export type ReviewTrigger = 'words' | 'sentence';

/** Whether the text changed enough since the last read (null = not yet). */
export function reviewTrigger(lastReviewed: string, current: string): ReviewTrigger | null {
  if (current.trim() === '' || current === lastReviewed) return null;
  const n = changedWords(lastReviewed, current);
  if (n >= WORDS_THRESHOLD) return 'words';
  if (n >= SENTENCE_MIN_WORDS && completesSentence(lastReviewed, current)) return 'sentence';
  return null;
}

/** The changed part, widened to whole paragraphs, for the model to focus on. */
export function changedExcerpt(prev: string, next: string): string {
  const r = changedRegion(prev, next);
  if (r.newEnd <= r.newStart) return '';
  const before = next.lastIndexOf('\n\n', r.newStart);
  const after = next.indexOf('\n\n', r.newEnd);
  const excerpt = next.slice(before === -1 ? 0 : before + 2, after === -1 ? next.length : after).trim();
  return excerpt.length > CHANGED_MAX_CHARS ? excerpt.slice(0, CHANGED_MAX_CHARS) : excerpt;
}

/** ms to wait before the next read may start (0 = now). */
export function cooldownLeft(lastStartedAt: number | null, now: number): number {
  if (lastStartedAt === null) return 0;
  return Math.max(0, lastStartedAt + MIN_INTERVAL_MS - now);
}
