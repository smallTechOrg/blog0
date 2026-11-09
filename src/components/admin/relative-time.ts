// "3 min ago" for the desk and the TLDR meta line. Pure; past a week it prints the design's
// date ("8 Sep 2026") in the site timezone.

import { fmtDate } from '@/lib/format-date';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function relativeTime(iso: string, now: Date, timeZone: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const diff = now.getTime() - at.getTime();
  if (diff < MIN) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MIN)} min ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} h ago`;
  if (diff < 2 * DAY) return 'yesterday';
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} days ago`;
  try {
    return fmtDate(at, timeZone);
  } catch {
    return fmtDate(at, 'UTC');
  }
}
