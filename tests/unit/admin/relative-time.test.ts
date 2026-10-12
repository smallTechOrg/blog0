import { describe, expect, it } from 'vitest';

import { relativeTime } from '@/components/admin/relative-time';

const NOW = new Date('2026-10-12T12:00:00Z');

describe('relativeTime', () => {
  it('says "just now" under a minute and minutes under an hour', () => {
    expect(relativeTime('2026-10-12T11:59:30Z', NOW, 'UTC')).toBe('just now');
    expect(relativeTime('2026-10-12T11:58:00Z', NOW, 'UTC')).toBe('2 min ago');
  });

  it('says hours under a day, then yesterday, then days under a week', () => {
    expect(relativeTime('2026-10-12T09:00:00Z', NOW, 'UTC')).toBe('3 h ago');
    expect(relativeTime('2026-10-11T10:00:00Z', NOW, 'UTC')).toBe('yesterday');
    expect(relativeTime('2026-10-08T12:00:00Z', NOW, 'UTC')).toBe('4 days ago');
  });

  it('falls back to the site-timezone date after a week, and for future or unparseable input', () => {
    expect(relativeTime('2026-09-08T12:00:00Z', NOW, 'Asia/Kolkata')).toBe('8 Sep 2026');
    expect(relativeTime('2026-10-12T12:00:20Z', NOW, 'UTC')).toBe('just now');
    expect(relativeTime('not a date', NOW, 'UTC')).toBe('');
  });
});
