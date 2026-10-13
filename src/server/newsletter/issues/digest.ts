// The digest rule (spec/architecture.md §13.5 digest.ts; capability newsletter-issues.md "Modes").
// Pure: no I/O. A digest is due when, since the anchor (the last digest issue, else the moment the
// mode was set, else the oldest new post), either `digestPosts` articles were first-published or
// `digestDays` days passed with ≥ 1 new article — whichever comes first. The posts rule is applied
// on every first publish; the days rule only by `pnpm newsletter:tick` (newsletter-issues.md
// success criteria: a publish 8 days later creates nothing until the tick runs).

export interface DigestSettings {
  digestDays: number;
  digestPosts: number;
}

export interface DigestDue {
  due: boolean;
  reason: 'posts' | 'days' | null;
  /** When the days rule fires for the current anchor (null without an anchor or without new posts). */
  dueAt: Date | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function dueDigest(settings: DigestSettings, anchorAt: Date | null, newPostCount: number, now: Date): DigestDue {
  if (newPostCount <= 0) return { due: false, reason: null, dueAt: null };
  const dueAt = anchorAt ? new Date(anchorAt.getTime() + settings.digestDays * DAY_MS) : null;
  if (newPostCount >= settings.digestPosts) return { due: true, reason: 'posts', dueAt };
  if (dueAt && now.getTime() >= dueAt.getTime()) return { due: true, reason: 'days', dueAt };
  return { due: false, reason: null, dueAt };
}

/** "<brand> · N new articles" (digest title; singular for one). */
export function digestTitle(brand: string, count: number): string {
  return `${brand} · ${count} new ${count === 1 ? 'article' : 'articles'}`;
}
