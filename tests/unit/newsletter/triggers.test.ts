import { describe, expect, it } from 'vitest';

import { settingsPatch } from '@/server/newsletter/schemas';
import { digestTitle, dueDigest } from '@/server/newsletter/issues/digest';

// The digest rule (spec/architecture.md §13.5 digest.ts; capability newsletter-issues.md success
// criteria: dueDigest over the four cases) and the settings bounds the triggers rely on.

const DAY = 24 * 60 * 60 * 1000;
const anchor = new Date('2026-10-01T00:00:00.000Z');
const at = (days: number) => new Date(anchor.getTime() + days * DAY);
const settings = { digestDays: 7, digestPosts: 3 };

describe('dueDigest', () => {
  it('posts reached → due for posts (before the days threshold)', () => {
    expect(dueDigest(settings, anchor, 3, at(1))).toEqual({ due: true, reason: 'posts', dueAt: at(7) });
  });

  it('days reached with ≥ 1 new post → due for days', () => {
    expect(dueDigest(settings, anchor, 1, at(8))).toEqual({ due: true, reason: 'days', dueAt: at(7) });
    expect(dueDigest(settings, anchor, 1, at(7))).toMatchObject({ due: true, reason: 'days' }); // boundary: exactly digestDays
  });

  it('neither threshold → not due, dueAt still reported', () => {
    expect(dueDigest(settings, anchor, 2, at(6.99))).toEqual({ due: false, reason: null, dueAt: at(7) });
  });

  it('no new posts → never due, whatever the time', () => {
    expect(dueDigest(settings, anchor, 0, at(100))).toEqual({ due: false, reason: null, dueAt: null });
  });

  it('without an anchor only the posts rule can fire', () => {
    expect(dueDigest(settings, null, 2, at(100))).toEqual({ due: false, reason: null, dueAt: null });
    expect(dueDigest(settings, null, 3, at(0))).toEqual({ due: true, reason: 'posts', dueAt: null });
  });

  it('posts wins when both thresholds are met', () => {
    expect(dueDigest(settings, anchor, 5, at(30)).reason).toBe('posts');
  });
});

describe('digestTitle', () => {
  it('"<brand> · N new articles", singular for one', () => {
    expect(digestTitle('blog0', 2)).toBe('blog0 · 2 new articles');
    expect(digestTitle('blog0', 1)).toBe('blog0 · 1 new article');
  });
});

describe('settings bounds used by the triggers', () => {
  it('rejects digestDays 0, digestPosts 21 and mode weekly; accepts the edges', () => {
    expect(settingsPatch.safeParse({ digestDays: 0 }).success).toBe(false);
    expect(settingsPatch.safeParse({ digestPosts: 21 }).success).toBe(false);
    expect(settingsPatch.safeParse({ mode: 'weekly' }).success).toBe(false);
    expect(settingsPatch.safeParse({ digestDays: 60, digestPosts: 1, mode: 'digest', autoSend: false }).success).toBe(true);
    expect(settingsPatch.safeParse({ modeSetAt: '2026-10-01T00:00:00.000Z' }).success).toBe(false);
  });
});
