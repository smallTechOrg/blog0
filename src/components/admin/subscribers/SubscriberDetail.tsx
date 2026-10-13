'use client';

import Link from 'next/link';
import { useRef, useState, type FormEvent } from 'react';

import type { AdminUnsubscribeResponse, SendConfirmationResponse, SubscriberDetailDto, SubscriberDetailResponse } from '@/lib/api/dto';

import { AdminLoadError, useAdminLoad } from '../AdminLoad';
import { apiRequest, signInHref } from '../api';
import { runExclusive } from '../editor/tldr-generate';

import { EraseDialog } from './EraseDialog';
import { SubscriberTimeline } from './SubscriberTimeline';
import {
  canErase,
  canUnsubscribe,
  eraseNotice,
  confirmationAction,
  dateTimeLabel,
  ipLine,
  LIST_PAGE,
  retryAtMessage,
  safeDate,
  sourceCells,
  statusPillLabel,
  statusTagClass,
  subscriberApi,
  subscriberHref,
} from './subscribers-api';

// Admin → Subscriber /admin/subscribers/[id] (spec/ui.md §4 "Subscriber"; capability
// newsletter-list): head, Send confirmation (legacy one-time / pending under the cap), Unsubscribe
// (permanent suppression, confirmed in a dialog), proof of consent, the event ledger, suppression
// entries and messages. States: loading, error + Retry / Sign in again, 404, ready.

export const UNSUBSCRIBE_CONFIRM = (email: string): string => `Unsubscribe ${email}? This writes a permanent suppression entry.`;

const NOTE_MAX = 300;

type Notice = { kind: 'ok'; text: string } | { kind: 'error'; text: string; signedOut: boolean } | null;

export function SubscriberDetail({ id, timeZone }: { id: string; timeZone: string }) {
  const path = subscriberHref(id);
  const { load, setLoad, reload } = useAdminLoad(() => apiRequest<SubscriberDetailResponse>(subscriberApi(id)), id);

  return (
    <main className="desk-main">
      <div className="desk-page subs-detail">
        <p className="admin-crumb">
          <Link href={LIST_PAGE}>← Subscribers</Link>
        </p>
        {load.kind === 'loading' ? (
          <p className="admin-muted" role="status" aria-live="polite">
            Loading the subscriber…
          </p>
        ) : null}
        {load.kind === 'error' && load.code === 'NOT_FOUND' ? (
          <div className="desk-empty">
            <p>That subscriber isn’t here.</p>
          </div>
        ) : null}
        {load.kind === 'error' && load.code !== 'NOT_FOUND' ? (
          <AdminLoadError error={load} what="the subscriber" onRetry={reload} signInPath={path} />
        ) : null}
        {load.kind === 'ready' ? (
          <SubscriberBody
            subscriber={load.data.subscriber}
            timeZone={timeZone}
            path={path}
            onChange={(subscriber) => setLoad({ kind: 'ready', data: { subscriber } })}
          />
        ) : null}
      </div>
    </main>
  );
}

function when(iso: string | null, timeZone: string): string {
  return iso ? safeDate(iso, timeZone) : '—';
}

function SubscriberBody({
  subscriber: s,
  timeZone,
  path,
  onChange,
}: {
  subscriber: SubscriberDetailDto;
  timeZone: string;
  path: string;
  onChange: (s: SubscriberDetailDto) => void;
}) {
  const [notice, setNotice] = useState<Notice>(null);
  const [sending, setSending] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [eraseDialog, setEraseDialog] = useState(false);
  const sendFlight = useRef(false);
  const action = confirmationAction(s, timeZone);
  const src = sourceCells(s);

  function sendConfirmation(): Promise<void> {
    return runExclusive(sendFlight, async () => {
      setSending(true);
      setNotice(null);
      const res = await apiRequest<SendConfirmationResponse>(subscriberApi(s.id, 'send-confirmation'), { method: 'POST' });
      setSending(false);
      if (res.ok) {
        onChange(res.data.subscriber);
        setNotice({ kind: 'ok', text: `Confirmation sent to ${res.data.sentTo} (${res.data.transport})` });
        return;
      }
      const capped = res.error.code === 'CONFIRMATION_ALREADY_SENT' ? retryAtMessage(res.error.details, timeZone) : null;
      setNotice({ kind: 'error', text: capped ?? res.error.message, signedOut: res.error.code === 'UNAUTHENTICATED' });
    }).then(() => undefined);
  }

  return (
    <>
      <header className="subs-head">
        <h1 className="desk-page__title mono subs-head__email">{s.email}</h1>
        <p className="subs-head__meta">
          <span className={statusTagClass(s.status)}>{statusPillLabel(s)}</span>
          {s.name ? <span>{s.name}</span> : null}
        </p>
        <p className="admin-muted">
          Signed up {when(s.createdAt, timeZone)}
          {s.sourceUrl ? (
            <>
              {' '}
              from <span className="mono">{s.sourceUrl}</span>
            </>
          ) : (
            <> ({src.main})</>
          )}
          {s.confirmedAt ? <> · Confirmed {when(s.confirmedAt, timeZone)}</> : null}
          {s.unsubscribedAt ? <> · Unsubscribed {when(s.unsubscribedAt, timeZone)}</> : null}
        </p>
      </header>

      <div className="admin-actions subs-actions">
        {action ? (
          <button
            type="button"
            className="admin-btn admin-btn--primary"
            disabled={action.disabled || sending}
            title={action.title}
            aria-busy={sending}
            onClick={() => void sendConfirmation()}
          >
            {sending ? 'Sending…' : action.label}
          </button>
        ) : null}
        {canUnsubscribe(s.status) ? (
          <button type="button" className="admin-btn" onClick={() => setDialog(true)}>
            Unsubscribe
          </button>
        ) : null}
        {canErase(s.email) ? (
          <button type="button" className="admin-btn admin-btn--danger" onClick={() => setEraseDialog(true)}>
            Erase personal data
          </button>
        ) : null}
      </div>
      {action?.disabled && action.title ? <p className="admin-hint">{action.title}</p> : null}
      <div aria-live="polite">
        {notice?.kind === 'ok' ? <p className="admin-ok">{notice.text}</p> : null}
        {notice?.kind === 'error' ? (
          <p className="admin-error" role="alert">
            {notice.signedOut ? (
              <>
                Your session ended — <a href={signInHref(path)}>sign in again</a>.
              </>
            ) : (
              notice.text
            )}
          </p>
        ) : null}
      </div>

      {dialog ? (
        <UnsubscribeDialog
          subscriber={s}
          onCancel={() => setDialog(false)}
          onDone={(next) => {
            setDialog(false);
            onChange(next);
            setNotice({ kind: 'ok', text: `${next.email} is unsubscribed; the suppression entry is permanent.` });
          }}
        />
      ) : null}

      {eraseDialog ? (
        <EraseDialog
          subscriber={s}
          onCancel={() => setEraseDialog(false)}
          onDone={(result) => {
            setEraseDialog(false);
            setNotice({ kind: 'ok', text: eraseNotice(result.providerRemoved) });
            // Reload in place (a full loading state would drop the notice): the tombstone + erased entry.
            void apiRequest<SubscriberDetailResponse>(subscriberApi(s.id)).then((res) => {
              if (res.ok) onChange(res.data.subscriber);
            });
          }}
        />
      ) : null}

      <section className="admin-card" aria-labelledby="subs-proof-h">
        <h2 className="admin-card__title" id="subs-proof-h">
          Proof of consent
        </h2>
        <dl className="admin-dl">
          <dt>Consent text</dt>
          <dd>{s.consentText ? <blockquote className="consent-quote">“{s.consentText}”</blockquote> : <span className="admin-faint">not recorded</span>}</dd>
          <dt>Consent version</dt>
          <dd className="mono">{s.consentVersion ?? '—'}</dd>
          <dt>Consented at</dt>
          <dd>{s.consentedAt ? <time dateTime={s.consentedAt}>{dateTimeLabel(s.consentedAt, timeZone)}</time> : '—'}</dd>
          <dt>Signup IP</dt>
          <dd className="mono">{ipLine(s, 'signup', timeZone)}</dd>
          <dt>Signup user agent</dt>
          <dd className="mono subs-ua">{s.signupUserAgent ?? '—'}</dd>
          <dt>Source page</dt>
          <dd className="mono">{s.sourceUrl ?? src.main}</dd>
          <dt>Confirmation IP</dt>
          <dd className="mono">{s.confirmedAt ? ipLine(s, 'confirmed', timeZone) : '—'}</dd>
          <dt>Confirmation user agent</dt>
          <dd className="mono subs-ua">{s.confirmedUserAgent ?? '—'}</dd>
          <dt>Confirmed at</dt>
          <dd>{s.confirmedAt ? <time dateTime={s.confirmedAt}>{dateTimeLabel(s.confirmedAt, timeZone)}</time> : '—'}</dd>
          {s.status === 'pending' ? (
            <>
              <dt>Token expires</dt>
              <dd>
                {s.confirmTokenExpiresAt ? <time dateTime={s.confirmTokenExpiresAt}>{dateTimeLabel(s.confirmTokenExpiresAt, timeZone)}</time> : '—'}
                {s.pendingExpired ? <span className="tag tag--pending subs-expired">expired</span> : null}
              </dd>
            </>
          ) : null}
          <dt>Confirmation emails sent</dt>
          <dd>{s.confirmationSentCount}</dd>
          <dt>Provider id</dt>
          <dd className="mono">{s.providerId ?? '—'}</dd>
          <dt>Last sync</dt>
          <dd>{s.providerSyncedAt ? <time dateTime={s.providerSyncedAt}>{dateTimeLabel(s.providerSyncedAt, timeZone)}</time> : '—'}</dd>
        </dl>
      </section>

      <section className="admin-card" aria-labelledby="subs-tl-h">
        <h2 className="admin-card__title" id="subs-tl-h">
          Timeline
        </h2>
        <SubscriberTimeline events={s.events} timeZone={timeZone} />
      </section>

      <section className="admin-card" aria-labelledby="subs-sup-h">
        <h2 className="admin-card__title" id="subs-sup-h">
          Suppression entries
        </h2>
        {s.suppressions.length === 0 ? (
          <p className="admin-muted">None</p>
        ) : (
          <div className="admin-tablewrap">
            <table className="data admin-table admin-table--compact">
              <caption className="admin-hint">Append-only — these entries are never removed.</caption>
              <thead>
                <tr>
                  <th scope="col">Reason</th>
                  <th scope="col">Source</th>
                  <th scope="col">When</th>
                  <th scope="col">Details</th>
                </tr>
              </thead>
              <tbody>
                {s.suppressions.map((x) => (
                  <tr key={x.id}>
                    <td>{x.reason}</td>
                    <td className="mono">{x.source}</td>
                    <td>
                      <time dateTime={x.createdAt} title={x.createdAt}>
                        {when(x.createdAt, timeZone)}
                      </time>
                    </td>
                    <td className="mono subs-ua">{Object.keys(x.details ?? {}).length ? JSON.stringify(x.details) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="admin-card" aria-labelledby="subs-msg-h">
        <h2 className="admin-card__title" id="subs-msg-h">
          Messages
        </h2>
        {s.messages.length === 0 ? (
          <p className="admin-muted">None sent yet.</p>
        ) : (
          <div className="admin-tablewrap">
            <table className="data admin-table admin-table--compact">
              <thead>
                <tr>
                  <th scope="col">Kind</th>
                  <th scope="col">Subject</th>
                  <th scope="col">Transport</th>
                  <th scope="col">Status</th>
                  <th scope="col">When</th>
                </tr>
              </thead>
              <tbody>
                {s.messages.map((m) => (
                  <tr key={m.id}>
                    <td>{m.kind}</td>
                    <td>{m.subject}</td>
                    <td className="mono">{m.transport}</td>
                    <td>{m.status}</td>
                    <td>
                      <time dateTime={m.createdAt} title={m.createdAt}>
                        {when(m.createdAt, timeZone)}
                      </time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function UnsubscribeDialog({
  subscriber,
  onCancel,
  onDone,
}: {
  subscriber: SubscriberDetailDto;
  onCancel: () => void;
  onDone: (s: SubscriberDetailDto) => void;
}) {
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flight = useRef(false);

  function submit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    void runExclusive(flight, async () => {
      setPending(true);
      setError(null);
      const trimmed = note.trim();
      const res = await apiRequest<AdminUnsubscribeResponse>(subscriberApi(subscriber.id, 'unsubscribe'), {
        method: 'POST',
        body: trimmed ? { note: trimmed } : {},
      });
      setPending(false);
      if (res.ok) onDone(res.data.subscriber);
      else setError(res.error.message);
    });
  }

  return (
    <div className="admin-dialog__scrim" onMouseDown={(e) => e.target === e.currentTarget && !pending && onCancel()}>
      <form
        className="admin-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="unsub-title"
        onSubmit={submit}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !pending) {
            e.preventDefault();
            onCancel();
          }
        }}
      >
        <h2 className="admin-dialog__title" id="unsub-title">
          {UNSUBSCRIBE_CONFIRM(subscriber.email)}
        </h2>
        <label className="admin-field">
          <span className="admin-label">
            Note <span className="admin-faint">(optional)</span>
          </span>
          <input className="admin-input" value={note} maxLength={NOTE_MAX} onChange={(e) => setNote(e.target.value)} disabled={pending} autoFocus />
        </label>
        {error ? (
          <p className="admin-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="admin-dialog__actions">
          <button type="submit" className="admin-btn admin-btn--primary" disabled={pending}>
            {pending ? 'Unsubscribing…' : 'Unsubscribe'}
          </button>
          <button type="button" className="admin-btn admin-btn--ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
