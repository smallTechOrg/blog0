// Archive model (design `Archive` in spec/design/design-app.js; spec/ui.md §3; capability
// reader-site): newest first, grouped by month of first publication, topic pills built from the
// topics published articles carry, `?topic=` pre-filters (footer topics land here filtered).
// Pure + isomorphic: the server page and the client list share it.

import type { PostCardViewModel } from '@/lib/view-models';

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** Longest `?topic=` value read; anything longer is treated as no filter (article topics are ≤ 40). */
export const TOPIC_QUERY_MAX = 80;

export const UNDATED_HEADING = 'Undated';

export interface ArchiveGroup {
  /** "YYYY-MM", or "undated". */
  key: string;
  heading: string;
  items: PostCardViewModel[];
}

/** "8 Sep 2026" → { year: 2026, month: 9 }, or null when the label is not a design date. */
function monthOf(label: string): { year: number; month: number } | null {
  const m = /^\s*\d{1,2}\s+([A-Za-z]{3})\s+(\d{4})\s*$/.exec(label);
  if (!m) return null;
  const idx = MONTHS_SHORT.indexOf(m[1] as (typeof MONTHS_SHORT)[number]);
  if (idx < 0) return null;
  return { year: Number(m[2]), month: idx + 1 };
}

/** Groups (already newest-first) rows by month; unparseable dates go to a last "Undated" group. */
export function groupByMonth(posts: readonly PostCardViewModel[]): ArchiveGroup[] {
  const groups: ArchiveGroup[] = [];
  const undated: PostCardViewModel[] = [];
  for (const p of posts) {
    const ym = monthOf(p.publishedLabel);
    if (!ym) {
      undated.push(p);
      continue;
    }
    const key = `${ym.year}-${String(ym.month).padStart(2, '0')}`;
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(p);
    else groups.push({ key, heading: `${MONTHS_LONG[ym.month - 1]} ${ym.year}`, items: [p] });
  }
  if (undated.length) groups.push({ key: 'undated', heading: UNDATED_HEADING, items: undated });
  return groups;
}

/** The row's date column: day + month ("8 Sep 2026" → "8 Sep"). */
export function rowDate(publishedLabel: string): string {
  return publishedLabel.trim().split(/\s+/).slice(0, 2).join(' ');
}

/** Topics the published articles carry, in order of first appearance (newest first), once each. */
export function archiveTopics(posts: readonly PostCardViewModel[]): string[] {
  const seen: string[] = [];
  for (const p of posts) {
    const t = p.topic.trim();
    if (t && !seen.includes(t)) seen.push(t);
  }
  return seen;
}

export function filterArchive(posts: readonly PostCardViewModel[], topic: string | null): PostCardViewModel[] {
  return topic ? posts.filter((p) => p.topic === topic) : posts.slice();
}

/** The design's header line: "N articles[ in Topic], newest first." */
export function archiveSummary(count: number, topic: string | null): string {
  return count + (count === 1 ? ' article' : ' articles') + (topic ? ' in ' + topic : '') + ', newest first.';
}

/** Reads `?topic=` from Next's searchParams: first value, trimmed; blank or over-long → null. */
export function topicFromQuery(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!t || t.length > TOPIC_QUERY_MAX) return null;
  return t;
}

/** The archive address for a topic (null → all topics). */
export function archiveHref(topic: string | null): string {
  return topic ? '/archive?topic=' + encodeURIComponent(topic) : '/archive';
}
