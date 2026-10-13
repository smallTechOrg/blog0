import type { IssueStatsDto } from '@/lib/api/dto';

import { relativeTime } from '../relative-time';

// Issue stats (spec/ui.md §4 "Issue" → Stats, sent issues only): six `.statbox` tiles — "n/a" when
// the provider does not report a number — and "as of <relative time>".

const TILES: ReadonlyArray<{ key: keyof Omit<IssueStatsDto, 'fetchedAt' | 'delivered'>; label: string }> = [
  { key: 'recipients', label: 'Recipients' },
  { key: 'sent', label: 'Sent' },
  { key: 'opens', label: 'Opens' },
  { key: 'clicks', label: 'Clicks' },
  { key: 'bounces', label: 'Bounces' },
  { key: 'unsubscribes', label: 'Unsubscribes' },
];

export function IssueStats({ stats, now, timeZone }: { stats: IssueStatsDto; now: Date; timeZone: string }) {
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
      </p>
    </div>
  );
}
