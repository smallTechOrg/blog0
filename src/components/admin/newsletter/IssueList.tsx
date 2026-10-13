'use client';

import Link from 'next/link';
import { useEffect } from 'react';

import type { IssueListResponse } from '@/lib/api/dto';

import { AdminLoadError, stamped, useAdminLoad } from '../AdminLoad';
import { apiRequest } from '../api';
import { relativeTime } from '../relative-time';

import { ISSUE_STATUS_LABEL, ISSUES_API, ISSUES_PAGE, issueHref, issueStatusClass, ORIGIN_LABEL, SETTINGS_HREF } from './newsletter-api';

// Admin → Newsletter /admin/newsletter (spec/ui.md §4 "Newsletter"; capability newsletter-issues):
// issue table (# · Title · Status · Origin · Posts · Recipients · Created · Sent), New issue,
// Settings. Rows that are `sending` poll every 3 s until they settle. States: loading, error +
// Retry / Sign in again, empty, populated.

export const POLL_MS = 3000;

const fetchIssues = () => stamped(apiRequest<IssueListResponse>(ISSUES_API));

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function IssueList({ timeZone }: { timeZone: string }) {
  const { load, setLoad, reload } = useAdminLoad(fetchIssues);
  const ready = load.kind === 'ready' ? load.data : null;
  const sending = ready ? ready.issues.some((i) => i.status === 'sending') : false;

  useEffect(() => {
    if (!sending) return;
    let live = true;
    const t = setTimeout(() => {
      void fetchIssues().then((res) => {
        if (live && res.ok) setLoad({ kind: 'ready', data: res.data });
      });
    }, POLL_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [sending, ready, setLoad]);

  return (
    <main className="desk-main">
      <div className="desk-page">
        <div className="desk-page__head">
          <h1 className="desk-page__title">
            Newsletter
            {ready ? <span className="admin-faint"> · {plural(ready.total, 'issue', 'issues')}</span> : null}
          </h1>
          <div className="admin-actions">
            <Link href={SETTINGS_HREF} className="admin-btn admin-btn--ghost">
              Settings
            </Link>
            <Link href={ISSUES_PAGE + '/new'} className="admin-btn admin-btn--primary">
              New issue
            </Link>
          </div>
        </div>
        {ready ? <p className="admin-faint nl-confirmed">{plural(ready.confirmedCount, 'confirmed subscriber', 'confirmed subscribers')}</p> : null}

        {load.kind === 'loading' ? (
          <p className="admin-muted" role="status" aria-live="polite">
            Loading issues…
          </p>
        ) : null}
        {load.kind === 'error' ? <AdminLoadError error={load} what="the issues" onRetry={reload} signInPath={ISSUES_PAGE} /> : null}

        {ready && ready.issues.length === 0 ? (
          <div className="desk-empty">
            <p>
              No issues yet. In <strong>Per post</strong> or <strong>Digest</strong> mode they appear here when you publish; or write one with{' '}
              <strong>New issue</strong>.
            </p>
          </div>
        ) : null}

        {ready && ready.issues.length > 0 ? (
          <div className="admin-tablewrap">
            <table className="data admin-table">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Title</th>
                  <th scope="col">Status</th>
                  <th scope="col">Origin</th>
                  <th scope="col">Posts</th>
                  <th scope="col">Recipients</th>
                  <th scope="col">Created</th>
                  <th scope="col">Sent</th>
                </tr>
              </thead>
              <tbody>
                {ready.issues.map((i) => (
                  <tr key={i.id}>
                    <td className="mono">{i.number}</td>
                    <td className="admin-table__title">
                      <Link href={issueHref(i.id)}>{i.title}</Link>
                    </td>
                    <td>
                      <span className={issueStatusClass(i.status)} title={i.status === 'failed' && i.lastError ? i.lastError : undefined}>
                        {i.status === 'sending' ? <span className="spinner" aria-hidden="true" /> : null}
                        {ISSUE_STATUS_LABEL[i.status]}
                      </span>
                    </td>
                    <td>{ORIGIN_LABEL[i.origin]}</td>
                    <td>{i.postCount}</td>
                    <td>{i.recipientCount ?? <span className="admin-faint">—</span>}</td>
                    <td className="admin-table__updated">
                      <time dateTime={i.createdAt} title={i.createdAt}>
                        {relativeTime(i.createdAt, ready.now, timeZone)}
                      </time>
                    </td>
                    <td className="admin-table__updated">
                      {i.sentAt ? (
                        <time dateTime={i.sentAt} title={i.sentAt}>
                          {relativeTime(i.sentAt, ready.now, timeZone)}
                        </time>
                      ) : (
                        <span className="admin-faint">—</span>
                      )}
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
