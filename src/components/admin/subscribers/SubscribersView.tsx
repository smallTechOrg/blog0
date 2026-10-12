'use client';

import type { SubscriberListResponse } from '@/lib/api/dto';

import { AdminLoadError, stamped, useAdminLoad } from '../AdminLoad';
import { apiRequest } from '../api';
import { relativeTime } from '../relative-time';

// Admin → Subscribers (spec/ui.md §4 "Later admin screens"): count, table, Export CSV.
// States: loading, error + Retry (or Sign in again), empty, populated.

const PATH = '/admin/subscribers';
export const CSV_HREF = '/api/admin/subscribers?format=csv';

const fetchSubscribers = () => stamped(apiRequest<SubscriberListResponse>('/api/admin/subscribers'));

export function SubscribersView({ timeZone }: { timeZone: string }) {
  const { load: state, reload } = useAdminLoad(fetchSubscribers);
  const ready = state.kind === 'ready' ? state.data : null;
  const total = ready ? ready.total : null;

  return (
    <main className="desk-main">
      <div className="desk-page">
        <div className="desk-page__head">
          <h1 className="desk-page__title">
            Subscribers
            {total !== null ? <span className="admin-faint"> · {total}</span> : null}
          </h1>
          {total ? (
            <a href={CSV_HREF} className="admin-btn admin-btn--primary" download>
              Export CSV
            </a>
          ) : null}
        </div>

        {state.kind === 'loading' ? (
          <p className="admin-muted" role="status" aria-live="polite">
            Loading subscribers…
          </p>
        ) : null}

        {state.kind === 'error' ? <AdminLoadError error={state} what="the subscribers" onRetry={reload} signInPath={PATH} /> : null}

        {ready && ready.subscribers.length === 0 ? (
          <div className="desk-empty">
            <p>No subscribers yet. Signups from the footer form on every public page land here.</p>
          </div>
        ) : null}

        {ready && ready.subscribers.length > 0 ? (
          <div className="admin-tablewrap">
            <table className="data admin-table">
              <thead>
                <tr>
                  <th scope="col">Email</th>
                  <th scope="col">Name</th>
                  <th scope="col">Status</th>
                  <th scope="col">Subscribed</th>
                </tr>
              </thead>
              <tbody>
                {ready.subscribers.map((s) => (
                  <tr key={s.email}>
                    <td className="admin-table__title mono">{s.email}</td>
                    <td>{s.name ? s.name : <span className="admin-faint">—</span>}</td>
                    <td>
                      <span className="tag">{s.status === 'subscribed' ? 'Subscribed' : 'Unsubscribed'}</span>
                    </td>
                    <td className="admin-table__updated">
                      <time dateTime={s.createdAt} title={s.createdAt}>
                        {relativeTime(s.createdAt, ready.now, timeZone)}
                      </time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </main>
  );
}
