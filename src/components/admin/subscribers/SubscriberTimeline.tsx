import type { SubscriberEventDto } from '@/lib/api/dto';

import { dateTimeLabel, eventLabel } from './subscribers-api';

// Per-subscriber event ledger (spec/ui.md §4 "Subscriber" → Timeline): every event oldest first —
// a dot by kind, label, source, actor, time; `details` as a collapsible JSON block. Append-only on
// the server, so this is a straight render (no effects).

export function SubscriberTimeline({ events, timeZone }: { events: SubscriberEventDto[]; timeZone: string }) {
  if (events.length === 0) return <p className="admin-muted">No events recorded.</p>;
  return (
    <ol className="timeline">
      {events.map((ev) => {
        const hasDetails = ev.details && Object.keys(ev.details).length > 0;
        return (
          <li key={ev.id} className="timeline__item" data-kind={ev.kind}>
            <span className="timeline__label">{eventLabel(ev)}</span>
            <span className="timeline__meta">
              <span className="mono">{ev.source}</span>
              {ev.actor ? <> · {ev.actor}</> : null}
              {ev.ip ? <> · IP {ev.ip}</> : null}
              {' · '}
              <time dateTime={ev.createdAt} title={ev.createdAt}>
                {dateTimeLabel(ev.createdAt, timeZone)}
              </time>
            </span>
            {ev.userAgent ? <span className="timeline__ua admin-faint">{ev.userAgent}</span> : null}
            {hasDetails ? (
              <details className="timeline__details">
                <summary>Details</summary>
                <pre className="mono">{JSON.stringify(ev.details, null, 2)}</pre>
              </details>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
