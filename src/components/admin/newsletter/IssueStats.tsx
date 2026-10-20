import type { IssueStatsDto } from '@/lib/api/dto';

import { relativeTime } from '../relative-time';

// Issue stats (spec/ui.md §4 "Issue" → Stats, sent issues only): six `.statbox` tiles — "n/a" when
// the provider does not report a number — and "as of <relative time>". Stage A: a failed
// auto-refresh keeps the last tiles and adds "Couldn’t refresh stats" beside "as of …"; when the
// provider's tracking URL is not public a muted note explains why opens stay empty.

export const STATS_REFRESH_FAILED = 'Couldn’t refresh stats';
export const TRACKING_NOT_PUBLIC = "Opens can't be counted: Listmonk's public URL isn't reachable from the internet.";

const TILES: ReadonlyArray<{ key: keyof Omit<IssueStatsDto, 'fetchedAt' | 'delivered'>; label: string }> = [
  { key: 'recipients', label: 'Recipients' },
  { key: 'sent', label: 'Sent' },
  { key: 'opens', label: 'Opens' },
  { key: 'clicks', label: 'Clicks' },
  { key: 'bounces', label: 'Bounces' },
  { key: 'unsubscribes', label: 'Unsubscribes' },
];

export function TrackingNote() {
  return <p className="admin-muted issue-tracking-note">{TRACKING_NOT_PUBLIC}</p>;
}

export function IssueStats({
  stats,
  now,
  timeZone,
  trackingPublic = true,
  refreshFailed = false,
}: {
  stats: IssueStatsDto;
  now: Date;
  timeZone: string;
  trackingPublic?: boolean;
  refreshFailed?: boolean;
}) {
  return (
    <div className="issue-stats">
      <div className="statboxes">
        {TILES.map((t) => {
          const v = stats[t.key];
          return (
            <div key={t.key} className="statbox">
              <span className="statbox__n">{v === null || v === undefined ? 'n/a' : v.toLocaleString('en-US')}</span>
              <span className="statbox__label">{t.label}</span>
            </div>
          );
        })}
      </div>
      <p className="admin-faint">
        <time dateTime={stats.fetchedAt} title={stats.fetchedAt}>
          {'as of ' + relativeTime(stats.fetchedAt, now, timeZone)}
        </time>
        {refreshFailed ? <span className="admin-muted">{' · ' + STATS_REFRESH_FAILED}</span> : null}
      </p>
      {trackingPublic ? null : <TrackingNote />}
    </div>
  );
}
