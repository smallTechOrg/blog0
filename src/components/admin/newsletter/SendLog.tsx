import type { IssueEventDto } from '@/lib/api/dto';

import { dateTimeLabel } from '../subscribers/subscribers-api';

import { issueEventLabel } from './newsletter-api';

// Send log (spec/ui.md §4 "Issue" → Send log): every issue event oldest first with time, actor and
// label (Created · Updated · Test sent to … · Send requested (n recipients) · Campaign created … ·
// Campaign started · Sent · Failed: … · Stats fetched).

export function SendLog({ events, timeZone }: { events: IssueEventDto[]; timeZone: string }) {
  if (events.length === 0) return <p className="admin-muted">Nothing logged yet.</p>;
  return (
    <ol className="timeline">
      {events.map((ev) => (
        <li key={ev.id} className="timeline__item" data-kind={ev.kind}>
          <span className="timeline__label">{issueEventLabel(ev)}</span>
          <span className="timeline__meta">
            {ev.actor ? <>{ev.actor} · </> : null}
            <time dateTime={ev.createdAt} title={ev.createdAt}>
              {dateTimeLabel(ev.createdAt, timeZone)}
            </time>
          </span>
        </li>
      ))}
    </ol>
  );
}
