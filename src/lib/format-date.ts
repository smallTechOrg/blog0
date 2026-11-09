// Dates the design's way ("8 Sep 2026"), in the site's timezone (spec/ui.md → fmtDate).
// Pure + isomorphic. Month names are fixed English abbreviations, not the locale's
// (en-GB ICU prints "Sept", which the design never does).

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    // Throws RangeError for an unknown zone.
    f = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' });
    formatters.set(timeZone, f);
  }
  return f;
}

function partsIn(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = formatterFor(timeZone).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

/**
 * Format an instant (ISO string or Date) as "8 Sep 2026" in `timeZone`.
 * A bare calendar date ("2026-09-08") is printed as that day, whatever the zone.
 * Throws RangeError on an unparseable date or an unknown timezone.
 */
export function fmtDate(value: string | Date, timeZone: string): string {
  if (typeof value === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (m) {
      formatterFor(timeZone); // still validate the zone
      return Number(m[3]) + ' ' + MONTHS[Number(m[2]) - 1] + ' ' + m[1];
    }
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError(`fmtDate: not a date: ${String(value)}`);
  const { year, month, day } = partsIn(date, timeZone);
  return day + ' ' + MONTHS[month - 1] + ' ' + year;
}

/** Calendar year of `date` in `timeZone` (footer "© <year>"). */
export function yearInZone(date: Date, timeZone: string): number {
  return partsIn(date, timeZone).year;
}
