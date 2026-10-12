'use client';

import { useCallback, useEffect, useState } from 'react';

import type { SubscriberDto, SubscriberListResponse } from '@/server/newsletter/types';

import { apiRequest, signInHref } from '../api';
import { relativeTime } from '../relative-time';

// Admin → Subscribers (spec/ui.md §4 "Later admin screens"): count, table, Export CSV.
// States: loading, error + Retry (or Sign in again), empty, populated.

const PATH = '/admin/subscribers';
export const CSV_HREF = '/api/admin/subscribers?format=csv';

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string; signedOut: boolean }
  | { kind: 'ready'; subscribers: SubscriberDto[]; total: number; now: Date };

async function fetchSubscribers(): Promise<State> {
  const res = await apiRequest<SubscriberListResponse>('/api/admin/subscribers');
  if (res.ok) return { kind: 'ready', subscribers: res.data.subscribers, total: res.data.total, now: new Date() };
  return { kind: 'error', message: res.error.message, signedOut: res.error.code === 'UNAUTHENTICATED' };
}

export function SubscribersView({ timeZone }: { timeZone: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    setState(await fetchSubscribers());
  }, []);

  useEffect(() => {
    let live = true;
    void fetchSubscribers().then((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
    };
  }, []);

  const total = state.kind === 'ready' ? state.total : null;

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

        {state.kind === 'error' ? (
          <div className="admin-alert" role="alert">
            <p>Couldn’t load the subscribers: {state.message}</p>
            {state.signedOut ? (
              <a className="admin-btn" href={signInHref(PATH)}>
                Sign in again
              </a>
            ) : (
              <button type="button" className="admin-btn" onClick={() => void load()}>
                Retry
              </button>
            )}
          </div>
        ) : null}

        {state.kind === 'ready' && state.subscribers.length === 0 ? (
          <div className="desk-empty">
            <p>No subscribers yet. Signups from the footer form on every public page land here.</p>
          </div>
        ) : null}

        {state.kind === 'ready' && state.subscribers.length > 0 ? (
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
                {state.subscribers.map((s) => (
                  <tr key={s.email}>
                    <td className="admin-table__title mono">{s.email}</td>
                    <td>{s.name ? s.name : <span className="admin-faint">—</span>}</td>
                    <td>
                      <span className="tag">{s.status === 'subscribed' ? 'Subscribed' : 'Unsubscribed'}</span>
                    </td>
                    <td className="admin-table__updated">
                      <time dateTime={s.createdAt} title={s.createdAt}>
                        {relativeTime(s.createdAt, state.now, timeZone)}
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
