'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import type { SubscriberListResponse } from '@/lib/api/dto';

import { AdminLoadError, stamped, useAdminLoad } from '../AdminLoad';
import { apiRequest } from '../api';
import { relativeTime } from '../relative-time';

import { StatusFilter } from './StatusFilter';
import {
  AUDIT_HREF,
  adminListHref,
  csvHref,
  ERASE_NOTICE_KEY,
  emptyMessage,
  legacySentence,
  listPath,
  LIST_PAGE,
  sourceCells,
  statusPillLabel,
  statusTagClass,
  subscriberHref,
  type StatusFilterValue,
} from './subscribers-api';

// Admin → Subscribers /admin/subscribers (spec/ui.md §4 "Subscribers"; capability newsletter-list):
// counts per status as filter pills, search by email (debounced), the table with links to the
// per-subscriber audit view, the legacy banner, Export CSV (active filter) and Export audit (JSON).
// States: loading, error + Retry (or Sign in again), empty (per filter/search), populated; plus the
// one-time confirmation after "Delete subscriber and personal data".

const SEARCH_DEBOUNCE_MS = 300;
const Q_MAX = 100;

export interface SubscribersViewProps {
  timeZone: string;
  initialStatus?: StatusFilterValue;
  initialQuery?: string;
}

export function SubscribersView({ timeZone, initialStatus = 'all', initialQuery = '' }: SubscribersViewProps) {
  const [filter, setFilter] = useState<StatusFilterValue>(initialStatus);
  const [query, setQuery] = useState(initialQuery);
  const [q, setQ] = useState(initialQuery.trim());
  // The one-time confirmation a deletion leaves for the list (SubscriberDetail → sessionStorage).
  const [notice, setNotice] = useState<{ kind: 'ok' | 'warn'; text: string } | null>(null);
  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(ERASE_NOTICE_KEY);
      if (raw === null) return;
      window.sessionStorage.removeItem(ERASE_NOTICE_KEY);
      const parsed = JSON.parse(raw) as { kind?: unknown; text?: unknown };
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read once from storage after mount (not available during SSR)
      if (typeof parsed.text === 'string') setNotice({ kind: parsed.kind === 'warn' ? 'warn' : 'ok', text: parsed.text });
    } catch {
      // storage unavailable or a malformed entry: no line
    }
  }, []);

  // Search is debounced 300 ms before it reaches the request key.
  useEffect(() => {
    const next = query.trim();
    if (next === q) return;
    const t = setTimeout(() => setQ(next), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query, q]);

  // The filter + search live in the admin URL (reload / share keeps them).
  useEffect(() => {
    const href = adminListHref(filter, q);
    if (window.location.pathname + window.location.search !== href) window.history.replaceState(window.history.state, '', href);
  }, [filter, q]);

  const path = listPath(filter, q);
  // Counts and the total survive a reload of the list (no flicker of the pills while filtering).
  const [counts, setCounts] = useState<SubscriberListResponse['counts'] | null>(null);
  const { load: state, reload } = useAdminLoad(() => stamped(apiRequest<SubscriberListResponse>(path)), path, (d) => setCounts(d.counts));
  const ready = state.kind === 'ready' ? state.data : null;

  const all = counts ? counts.all : null;
  const legacy = counts ? counts.legacy_unconfirmed : 0;

  return (
    <main className="desk-main">
      <div className="desk-page">
        <div className="desk-page__head">
          <h1 className="desk-page__title">
            Subscribers
            {all !== null ? <span className="admin-faint"> · {all}</span> : null}
          </h1>
          {all ? (
            <div className="admin-actions">
              <a href={csvHref(filter)} className="admin-btn admin-btn--primary" download>
                Export CSV
              </a>
              <a href={AUDIT_HREF} className="admin-btn" download title="Every subscriber, event and suppression — the proof of consent">
                Export audit (JSON)
              </a>
            </div>
          ) : null}
        </div>

        {notice ? (
          <div aria-live="polite">
            {notice.kind === 'ok' ? (
              <p className="admin-ok" role="status">
                {notice.text}
              </p>
            ) : (
              <p className="admin-alert is-warn" role="alert">
                {notice.text}
              </p>
            )}
          </div>
        ) : null}

        <div className="subs-tools">
          <StatusFilter counts={counts} value={filter} onChange={setFilter} />
          <label className="subs-search">
            <span className="sr">Find by email</span>
            <input
              type="search"
              className="admin-input"
              placeholder="Find by email"
              value={query}
              maxLength={Q_MAX}
              onChange={(e) => setQuery(e.target.value)}
              autoComplete="off"
            />
          </label>
        </div>

        {legacy > 0 ? (
          <div className="admin-alert is-warn subs-legacy" role="note">
            <p>{legacySentence(legacy)}</p>
            <p>
              <Link href="/admin/site#newsletter">Manage in Site → Newsletter</Link>
            </p>
          </div>
        ) : null}

        {state.kind === 'loading' ? (
          <p className="admin-muted" role="status" aria-live="polite">
            Loading subscribers…
          </p>
        ) : null}

        {state.kind === 'error' ? <AdminLoadError error={state} what="the subscribers" onRetry={reload} signInPath={LIST_PAGE} /> : null}

        {ready && ready.subscribers.length === 0 ? (
          <div className="desk-empty">
            <p>{emptyMessage(filter, q)}</p>
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
                  <th scope="col">Signed up</th>
                  <th scope="col">Confirmed</th>
                  <th scope="col">Source</th>
                  <th scope="col">Synced</th>
                </tr>
              </thead>
              <tbody>
                {ready.subscribers.map((s) => {
                  const src = sourceCells(s);
                  return (
                    <tr key={s.id}>
                      <td className="admin-table__title mono">
                        <Link href={subscriberHref(s.id)}>{s.email}</Link>
                      </td>
                      <td>{s.name ? s.name : <span className="admin-faint">—</span>}</td>
                      <td>
                        <span className={statusTagClass(s.status)}>{statusPillLabel(s)}</span>
                      </td>
                      <td className="admin-table__updated">
                        <time dateTime={s.createdAt} title={s.createdAt}>
                          {relativeTime(s.createdAt, ready.now, timeZone)}
                        </time>
                      </td>
                      <td className="admin-table__updated">
                        {s.confirmedAt ? (
                          <time dateTime={s.confirmedAt} title={s.confirmedAt}>
                            {relativeTime(s.confirmedAt, ready.now, timeZone)}
                          </time>
                        ) : (
                          <span className="admin-faint">—</span>
                        )}
                      </td>
                      <td>
                        {src.main}
                        {src.faint ? <span className="admin-table__slug mono">{src.faint}</span> : null}
                      </td>
                      <td className="admin-table__updated">
                        {s.providerSyncedAt ? (
                          <time dateTime={s.providerSyncedAt} title={s.providerSyncedAt}>
                            ✓ {relativeTime(s.providerSyncedAt, ready.now, timeZone)}
                          </time>
                        ) : (
                          <span className="admin-faint">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </main>
  );
}
