import { describe, expect, it } from 'vitest';

import { fmtDate, yearInZone } from '@/lib/format-date';

describe('fmtDate', () => {
  it('formats an instant in the site timezone the design way', () => {
    expect(fmtDate('2026-09-08T04:30:00.000Z', 'Asia/Kolkata')).toBe('8 Sep 2026');
  });

  it('uses the site timezone, not UTC, to pick the calendar day', () => {
    // 20:00 UTC on 7 Sep is 01:30 on 8 Sep in Kolkata.
    expect(fmtDate('2026-09-07T20:00:00Z', 'Asia/Kolkata')).toBe('8 Sep 2026');
    expect(fmtDate('2026-09-07T20:00:00Z', 'UTC')).toBe('7 Sep 2026');
  });

  it('accepts a Date and a bare calendar date', () => {
    expect(fmtDate(new Date('2026-12-31T12:00:00Z'), 'UTC')).toBe('31 Dec 2026');
    expect(fmtDate('2026-01-05', 'America/Los_Angeles')).toBe('5 Jan 2026');
  });

  it('rejects an unparseable date instead of printing "Invalid Date"', () => {
    expect(() => fmtDate('not a date', 'UTC')).toThrow(RangeError);
  });

  it('rejects an unknown timezone', () => {
    expect(() => fmtDate('2026-09-08T00:00:00Z', 'Mars/Olympus')).toThrow(RangeError);
  });
});

describe('yearInZone', () => {
  it('returns the calendar year in the given timezone', () => {
    expect(yearInZone(new Date('2026-12-31T20:00:00Z'), 'Asia/Kolkata')).toBe(2027);
    expect(yearInZone(new Date('2026-12-31T20:00:00Z'), 'UTC')).toBe(2026);
  });
});
