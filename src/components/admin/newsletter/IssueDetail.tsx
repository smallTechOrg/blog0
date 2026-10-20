'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import {
  NEWSLETTER_SETTINGS_LIMITS as L,
  type ArticleListItemDto,
  type ArticleListResponse,
  type IssueDeleteResponse,
  type IssueDetailDto,
  type IssueDetailResponse,
  type IssuePreviewDto,
  type IssueTestResponse,
  type NewsletterSettingsResponse,
  type NewsletterStatusDto,
} from '@/lib/api/dto';

import { AdminLoadError, stamped, useAdminLoad } from '../AdminLoad';
import { apiRequest, signInHref, type ApiResult } from '../api';
import { runExclusive } from '../editor/tldr-generate';
import { relativeTime } from '../relative-time';
import { safeDate } from '../subscribers/subscribers-api';

import { moveId, postsInvalidMessage, publishedArticles, validateCompose, type ComposeErrors } from './issue-edit';
import { IssuePreview, type PreviewTab } from './IssuePreview';
import { POLL_MS } from './IssueList';
import { IssueStats, TrackingNote } from './IssueStats';
import {
  ISSUE_STATUS_LABEL,
  issueApi,
  issueHref,
  issuePreviewPageHref,
  ISSUES_PAGE,
  issueStatusClass,
  ORIGIN_LABEL,
  SETTINGS_API,
  POSTAL_WARNING,
  postalAddressMissing,
  sentLine,
} from './newsletter-api';
import { PostPicker } from './PostPicker';
import { SendDialog } from './SendDialog';
import { SendLog } from './SendLog';
import { startStatsAutoRefresh } from './stats-refresh';

// Admin → Newsletter → Issue /admin/newsletter/[id] (spec/ui.md §4 "Issue"; capability
// newsletter-issues): head, inline edit while draft (title, intro, posts ↑ ↓ ✕ + Add post), actions
// (Send test to me · Send with the one-click confirm dialog · Refresh stats · Delete draft · Open
// preview in new tab), HTML/Text preview, send log, stats. Polls every 3 s while `sending`.
// Stage A: a sent issue's stats refresh on open and every 60 s while the tab is visible
// (stats-refresh.ts); the trackingPublic note sits under the tiles.
// States: loading, error + Retry / Sign in again, 404 "That issue isn’t here.", ready.

type Stamped = IssueDetailResponse & { now: Date };
type Notice = { kind: 'ok'; text: string } | { kind: 'error'; text: string; signedOut: boolean } | null;

export const STUCK_SENDING_TEXT = 'the send has been stuck in Sending for over 10 minutes (the request was interrupted)';

/** Whether Send / Try again is offered, and the failure line shown above Try again (`failed` = this session's own failure). */
export function sendAffordance(
  issue: Pick<IssueDetailDto, 'status' | 'lastError' | 'stuckSending'>,
  failed: string | null,
): { canSend: boolean; shownFailure: string | null; polling: boolean } {
  const canSend = issue.status === 'draft' || issue.status === 'failed' || issue.stuckSending;
  const shownFailure = failed ?? (issue.status === 'failed' ? (issue.lastError ?? 'unknown error') : issue.stuckSending ? STUCK_SENDING_TEXT : null);
  return { canSend, shownFailure, polling: issue.status === 'sending' && !issue.stuckSending };
}

function postsKey(issue: IssueDetailDto): string {
  return JSON.stringify(issue.posts);
}

export function IssueDetail({ id, timeZone }: { id: string; timeZone: string }) {
  const fetchIssue = () => stamped(apiRequest<IssueDetailResponse>(issueApi(id)));
  const { load, setLoad, reload } = useAdminLoad(fetchIssue, id);

  return (
    <main className="desk-main">
      <div className="desk-page issue-page">
        <p className="admin-crumb">
          <Link href={ISSUES_PAGE}>← Newsletter</Link>
        </p>
        {load.kind === 'loading' ? (
          <p className="admin-muted" role="status" aria-live="polite">
            Loading the issue…
          </p>
        ) : null}
        {load.kind === 'error' && load.code === 'NOT_FOUND' ? (
          <div className="desk-empty">
            <p>That issue isn’t here.</p>
          </div>
        ) : null}
        {load.kind === 'error' && load.code !== 'NOT_FOUND' ? (
          <AdminLoadError error={load} what="the issue" onRetry={reload} signInPath={issueHref(id)} />
        ) : null}
        {load.kind === 'ready' ? (
          <IssueBody data={load.data} timeZone={timeZone} onIssue={(issue) => setLoad({ kind: 'ready', data: { issue, now: new Date() } })} />
        ) : null}
      </div>
    </main>
  );
}

function IssueBody({ data, timeZone, onIssue }: { data: Stamped; timeZone: string; onIssue: (issue: IssueDetailDto) => void }) {
  const { issue, now } = data;
  const router = useRouter();
  const path = issueHref(issue.id);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState<null | 'test' | 'stats' | 'delete' | 'checking' | 'send'>(null);
  const [dialog, setDialog] = useState<{ recipients: number; sender: NewsletterStatusDto['sender'] } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const flight = useRef(false);

  // Preview: (re)loaded on mount and after every save; a draft is re-snapshotted by the server.
  const [previewTick, setPreviewTick] = useState(0);
  const [tab, setTab] = useState<PreviewTab>('html');
  const [preview, setPreview] = useState<{ kind: 'loading' } | { kind: 'ready'; data: IssuePreviewDto; refreshed: boolean } | { kind: 'error'; message: string }>({
    kind: 'loading',
  });
  const latestIssue = useRef(issue);
  const onIssueRef = useRef(onIssue);
  useEffect(() => {
    latestIssue.current = issue;
    onIssueRef.current = onIssue;
  });

  // Stage A: stats auto-refresh for a sent issue. Shares `flight` with the action buttons, so at most
  // one request runs at a time; a skipped tick simply waits for the next one.
  const [statsFailed, setStatsFailed] = useState(false);
  const isSent = issue.status === 'sent';
  useEffect(() => {
    if (!isSent) return;
    let live = true;
    const stop = startStatsAutoRefresh(() =>
      runExclusive(flight, async () => {
        const res = await apiRequest<IssueDetailResponse>(issueApi(issue.id, 'stats'), { method: 'POST' });
        if (!live) return;
        setStatsFailed(!res.ok);
        if (res.ok) onIssueRef.current(res.data.issue);
      }),
    );
    return () => {
      live = false;
      stop();
    };
  }, [issue.id, isSent]);
  useEffect(() => {
    let live = true;
    void apiRequest<IssuePreviewDto>(issueApi(issue.id, 'preview')).then(async (res) => {
      if (!live) return;
      if (!res.ok) {
        setPreview({ kind: 'error', message: res.error.message });
        return;
      }
      let refreshed = false;
      const before = latestIssue.current;
      if (before.status === 'draft') {
        // The preview persisted a fresh snapshot of the posts: pick it up when something changed.
        const again = await apiRequest<IssueDetailResponse>(issueApi(before.id));
        if (!live) return;
        if (again.ok && postsKey(again.data.issue) !== postsKey(before)) {
          refreshed = true;
          onIssue(again.data.issue);
        }
      }
      setPreview({ kind: 'ready', data: res.data, refreshed });
    });
    return () => {
      live = false;
    };
    // onIssue is stable enough for this purpose; the preview reloads only on tick / issue change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issue.id, previewTick]);

  // Poll while the provider is sending (status `sending`, or our own send request is in flight) — but not
  // once the send is stuck (no progress for 10 min): then Try again is offered instead.
  const polling = sendAffordance(issue, null).polling || busy === 'send';
  useEffect(() => {
    if (!polling) return;
    let live = true;
    const t = setTimeout(() => {
      void apiRequest<IssueDetailResponse>(issueApi(issue.id)).then((res) => {
        if (live && res.ok && res.data.issue.status !== 'draft') onIssue(res.data.issue);
      });
    }, POLL_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [polling, issue, onIssue]);

  function fail<T>(res: ApiResult<T> & { ok: false }): void {
    setNotice({ kind: 'error', text: res.error.message, signedOut: res.error.code === 'UNAUTHENTICATED' });
  }

  async function refetch(): Promise<void> {
    const res = await apiRequest<IssueDetailResponse>(issueApi(issue.id));
    if (res.ok) onIssue(res.data.issue);
  }

  function sendTest(): void {
    void runExclusive(flight, async () => {
      setBusy('test');
      setNotice(null);
      const res = await apiRequest<IssueTestResponse>(issueApi(issue.id, 'test'), { method: 'POST' });
      setBusy(null);
      if (!res.ok) return fail(res);
      setNotice({ kind: 'ok', text: `Test sent to ${res.data.sentTo} (${res.data.transport})` });
      await refetch();
    });
  }

  function openSend(): void {
    void runExclusive(flight, async () => {
      setBusy('checking');
      setNotice(null);
      const res = await apiRequest<NewsletterSettingsResponse>(SETTINGS_API);
      setBusy(null);
      if (!res.ok) return fail(res);
      setDialog({ recipients: res.data.status.counts.confirmed, sender: res.data.status.sender });
    });
  }

  function send(): void {
    void runExclusive(flight, async () => {
      setBusy('send');
      setNotice(null);
      setFailed(null);
      const res = await apiRequest<IssueDetailResponse>(issueApi(issue.id, 'send'), { method: 'POST', body: { confirm: true } });
      setBusy(null);
      setDialog(null);
      if (res.ok) {
        onIssue(res.data.issue);
        if (res.data.issue.status === 'failed') setFailed(res.data.issue.lastError ?? 'the sender reported a failure');
        else setNotice({ kind: 'ok', text: sentLine(res.data.issue.recipientCount) });
        return;
      }
      const detail = res.error.details && typeof res.error.details === 'object' ? (res.error.details as { issue?: IssueDetailDto }).issue : undefined;
      if (res.error.code === 'SENDER_FAILED') {
        if (detail) onIssue(detail);
        else await refetch();
        setFailed(detail?.lastError ?? res.error.message);
        return;
      }
      fail(res);
      if (res.error.code === 'ISSUE_NOT_DRAFT') await refetch();
    });
  }

  function refreshStats(): void {
    void runExclusive(flight, async () => {
      setBusy('stats');
      setNotice(null);
      const res = await apiRequest<IssueDetailResponse>(issueApi(issue.id, 'stats'), { method: 'POST' });
      setBusy(null);
      if (!res.ok) return fail(res);
      setStatsFailed(false);
      onIssue(res.data.issue);
    });
  }

  function deleteDraft(): void {
    if (!window.confirm(`Delete draft #${issue.number} “${issue.title}”? This can’t be undone.`)) return;
    void runExclusive(flight, async () => {
      setBusy('delete');
      setNotice(null);
      const res = await apiRequest<IssueDeleteResponse>(issueApi(issue.id), { method: 'DELETE' });
      setBusy(null);
      if (!res.ok) return fail(res);
      router.push(ISSUES_PAGE);
    });
  }

  const { canSend, shownFailure } = sendAffordance(issue, failed);
  const postalWarn = canSend && postalAddressMissing(issue.warnings);

  return (
    <>
      <header className="issue-head">
        <h1 className="desk-page__title">
          #{issue.number} · {issue.title}
        </h1>
        <p className="issue-head__meta">
          <span className={issueStatusClass(issue.status)}>
            {issue.status === 'sending' ? <span className="spinner" aria-hidden="true" /> : null}
            {ISSUE_STATUS_LABEL[issue.status]}
            {issue.status === 'sent' && issue.recipientCount !== null ? ` · ${issue.recipientCount} ${issue.recipientCount === 1 ? 'recipient' : 'recipients'}` : ''}
          </span>
          <span className="tag tag--plain">{ORIGIN_LABEL[issue.origin]}</span>
        </p>
        <p className="admin-muted">
          Created{' '}
          <time dateTime={issue.createdAt} title={issue.createdAt}>
            {relativeTime(issue.createdAt, now, timeZone)}
          </time>
          {issue.createdBy ? ` by ${issue.createdBy}` : ''}
          {issue.sentAt ? (
            <>
              {' · '}Sent{' '}
              <time dateTime={issue.sentAt} title={issue.sentAt}>
                {safeDate(issue.sentAt, timeZone)}
              </time>
              {issue.sentBy ? ` by ${issue.sentBy}` : ''}
              {issue.recipientCount !== null ? ` · ${issue.recipientCount} recipients` : ''}
            </>
          ) : null}
        </p>
      </header>

      {postalWarn ? (
        <p className="admin-warn" role="status">
          {POSTAL_WARNING} <Link href="/admin/site">Open Site settings</Link>
        </p>
      ) : null}
      <div className="admin-actions issue-actions">
        <button type="button" className="admin-btn" onClick={sendTest} disabled={busy !== null} aria-busy={busy === 'test'}>
          {busy === 'test' ? 'Sending test…' : 'Send test to me'}
        </button>
        {canSend ? (
          <button type="button" className="admin-btn admin-btn--primary" onClick={openSend} disabled={busy !== null} aria-busy={busy === 'checking'}>
            {busy === 'checking' ? 'Checking recipients…' : busy === 'send' ? 'Sending…' : 'Send'}
          </button>
        ) : null}
        {issue.status === 'sent' ? (
          <button type="button" className="admin-btn" onClick={refreshStats} disabled={busy !== null} aria-busy={busy === 'stats'}>
            {busy === 'stats' ? 'Refreshing…' : 'Refresh stats'}
          </button>
        ) : null}
        {issue.status === 'draft' ? (
          <button type="button" className="admin-btn admin-btn--ghost" onClick={deleteDraft} disabled={busy !== null}>
            {busy === 'delete' ? 'Deleting…' : 'Delete draft'}
          </button>
        ) : null}
        <a className="admin-btn admin-btn--ghost" href={issuePreviewPageHref(issue.id)} target="_blank" rel="noopener">
          Open preview in new tab
        </a>
      </div>
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
      {shownFailure && canSend ? (
        <div className="failcard" role="alert">
          <p>Couldn’t send: {shownFailure}</p>
          <p>
            <button type="button" className="admin-btn admin-btn--small" onClick={openSend} disabled={busy !== null}>
              Try again
            </button>
          </p>
        </div>
      ) : null}

      {dialog ? <SendDialog recipients={dialog.recipients} sender={dialog.sender} pending={busy === 'send'} postalAddressMissing={postalWarn} onSend={send} onCancel={() => setDialog(null)} /> : null}

      {issue.editable ? (
        <EditPanel
          key={issue.id}
          issue={issue}
          timeZone={timeZone}
          onSaved={(next) => {
            onIssue(next);
            setPreviewTick((n) => n + 1);
          }}
        />
      ) : (
        <ReadOnlyBody issue={issue} />
      )}

      <section className="admin-card" aria-labelledby="issue-prev-h">
        <h2 className="admin-card__title" id="issue-prev-h">
          Preview
        </h2>
        {preview.kind === 'loading' ? (
          <p className="admin-muted" role="status">
            Loading the preview…
          </p>
        ) : null}
        {preview.kind === 'error' ? (
          <AdminLoadError error={{ message: preview.message, signedOut: false }} what="the preview" onRetry={() => setPreviewTick((n) => n + 1)} small />
        ) : null}
        {preview.kind === 'ready' ? <IssuePreview preview={preview.data} tab={tab} onTab={setTab} refreshed={preview.refreshed} /> : null}
      </section>

      <section className="admin-card" aria-labelledby="issue-log-h">
        <h2 className="admin-card__title" id="issue-log-h">
          Send log
        </h2>
        <SendLog events={issue.events} timeZone={timeZone} />
      </section>

      {issue.status === 'sent' ? (
        <section className="admin-card" aria-labelledby="issue-stats-h">
          <h2 className="admin-card__title" id="issue-stats-h">
            Stats
          </h2>
          {issue.stats ? (
            <IssueStats stats={issue.stats} now={now} timeZone={timeZone} trackingPublic={issue.trackingPublic !== false} refreshFailed={statsFailed} />
          ) : (
            <>
              <p className="admin-muted">No stats yet — Refresh stats.</p>
              {issue.trackingPublic === false ? <TrackingNote /> : null}
            </>
          )}
        </section>
      ) : null}
    </>
  );
}

function ReadOnlyBody({ issue }: { issue: IssueDetailDto }) {
  return (
    <section className="admin-card" aria-labelledby="issue-body-h">
      <h2 className="admin-card__title" id="issue-body-h">
        Posts
      </h2>
      {issue.introMd ? <p className="issue-intro">{issue.introMd}</p> : null}
      <ol className="postpick__order">
        {issue.posts.map((p) => (
          <li key={p.articleId} className="postpick__row">
            <span className="postpick__title">{p.title}</span>
            <span className="admin-faint">
              {' '}
              · {p.topic} · {p.publishedLabel}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

type Save = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; message: string; signedOut: boolean };

function EditPanel({ issue, timeZone, onSaved }: { issue: IssueDetailDto; timeZone: string; onSaved: (issue: IssueDetailDto) => void }) {
  const [title, setTitle] = useState(issue.title);
  const [introMd, setIntroMd] = useState(issue.introMd);
  const [ids, setIds] = useState<string[]>(() => issue.posts.map((p) => p.articleId));
  const [errors, setErrors] = useState<ComposeErrors>({});
  const [save, setSave] = useState<Save>({ kind: 'idle' });
  const [adding, setAdding] = useState(false);
  const [articles, setArticles] = useState<ArticleListItemDto[] | null>(null);
  const flight = useRef(false);
  const pending = save.kind === 'saving';
  const savedIds = issue.posts.map((p) => p.articleId);
  const dirty = title !== issue.title || introMd !== issue.introMd || ids.join() !== savedIds.join();

  const titles = new Map<string, string>(issue.posts.map((p) => [p.articleId, p.title]));
  for (const a of articles ?? []) if (!titles.has(a.id)) titles.set(a.id, a.title);

  function edited(): void {
    if (save.kind !== 'idle' && save.kind !== 'saving') setSave({ kind: 'idle' });
  }

  function onSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    void runExclusive(flight, async () => {
      const found = validateCompose({ title, introMd, articleIds: ids });
      if (Object.keys(found).length) {
        setErrors(found);
        setSave({ kind: 'error', message: 'Fix the highlighted fields, then save.', signedOut: false });
        return;
      }
      const body: { title?: string; introMd?: string; articleIds?: string[] } = {};
      if (title.trim() !== issue.title) body.title = title.trim();
      if (introMd !== issue.introMd) body.introMd = introMd;
      if (ids.join() !== savedIds.join()) body.articleIds = ids;
      if (Object.keys(body).length === 0) return;
      setErrors({});
      setSave({ kind: 'saving' });
      const res = await apiRequest<IssueDetailResponse>(issueApi(issue.id), { method: 'PATCH', body });
      if (res.ok) {
        const next = res.data.issue;
        setTitle(next.title);
        setIntroMd(next.introMd);
        setIds(next.posts.map((p) => p.articleId));
        setSave({ kind: 'saved' });
        onSaved(next);
        return;
      }
      if (res.error.code === 'ISSUE_POSTS_INVALID') {
        const named = [...titles].map(([id, t]) => ({ id, title: t }));
        setErrors({ articleIds: postsInvalidMessage(res.error.details, named) ?? res.error.message });
      }
      setSave({ kind: 'error', message: res.error.message, signedOut: res.error.code === 'UNAUTHENTICATED' });
    });
  }

  function openAdd(): void {
    setAdding(true);
    if (articles) return;
    void apiRequest<ArticleListResponse>('/api/admin/articles').then((res) => {
      if (res.ok) setArticles(publishedArticles(res.data.articles));
      else setSave({ kind: 'error', message: res.error.message, signedOut: res.error.code === 'UNAUTHENTICATED' });
    });
  }

  return (
    <form className="admin-card admin-form issue-edit" onSubmit={onSubmit} noValidate aria-label="Edit draft">
      <h2 className="admin-card__title">Draft</h2>
      <div className="admin-field">
        <label className="admin-label" htmlFor="issue-edit-title">
          Title
        </label>
        <input
          id="issue-edit-title"
          className="admin-input"
          value={title}
          maxLength={L.issueTitle}
          disabled={pending}
          onChange={(e) => {
            setTitle(e.target.value);
            edited();
          }}
          aria-invalid={errors.title ? true : undefined}
          autoComplete="off"
        />
        {errors.title ? <span className="admin-error">{errors.title}</span> : null}
      </div>
      <div className="admin-field">
        <label className="admin-label" htmlFor="issue-edit-intro">
          Intro <span className="admin-faint">(optional)</span>
        </label>
        <textarea
          id="issue-edit-intro"
          className="admin-input"
          rows={4}
          value={introMd}
          maxLength={L.issueIntroMd}
          disabled={pending}
          onChange={(e) => {
            setIntroMd(e.target.value);
            edited();
          }}
          aria-invalid={errors.introMd ? true : undefined}
        />
        <span className="admin-hint">Paragraphs, emphasis and links only.</span>
        {errors.introMd ? <span className="admin-error">{errors.introMd}</span> : null}
      </div>
      <div className="admin-field">
        <span className="admin-label">Posts</span>
        {ids.length === 0 ? <p className="admin-muted">No posts — add at least one.</p> : null}
        <ol className="postpick__order" aria-label="Posts in the issue">
          {ids.map((id, i) => {
            const t = titles.get(id) ?? id;
            return (
              <li key={id} className="postpick__row">
                <span className="postpick__title">{t}</span>
                <span className="postpick__tools">
                  <button type="button" className="deck__btn" aria-label={`Move ${t} up`} disabled={pending || i === 0} onClick={() => (setIds(moveId(ids, i, -1)), edited())}>
                    ↑
                  </button>
                  <button
                    type="button"
                    className="deck__btn"
                    aria-label={`Move ${t} down`}
                    disabled={pending || i === ids.length - 1}
                    onClick={() => (setIds(moveId(ids, i, 1)), edited())}
                  >
                    ↓
                  </button>
                  <button type="button" className="deck__btn" aria-label={`Remove ${t}`} disabled={pending} onClick={() => (setIds(ids.filter((x) => x !== id)), edited())}>
                    ✕
                  </button>
                </span>
              </li>
            );
          })}
        </ol>
        <p>
          <button type="button" className="admin-btn admin-btn--small" onClick={openAdd} disabled={pending}>
            Add post
          </button>
        </p>
        {errors.articleIds ? (
          <span className="admin-error" role="alert">
            {errors.articleIds}
          </span>
        ) : null}
      </div>
      <div className="admin-form__actions">
        <button type="submit" className="admin-btn admin-btn--primary" disabled={pending || !dirty} aria-busy={pending}>
          {pending ? 'Saving…' : 'Save'}
        </button>
        {dirty && !pending ? <span className="admin-faint">Unsaved changes</span> : null}
      </div>
      <div aria-live="polite">
        {save.kind === 'saved' ? <p className="admin-ok">Saved — the preview is refreshed.</p> : null}
        {save.kind === 'error' ? (
          <p className="admin-error" role="alert">
            {save.signedOut ? (
              <>
                Your session ended — <a href={signInHref(issueHref(issue.id))}>sign in again</a>.
              </>
            ) : (
              save.message
            )}
          </p>
        ) : null}
      </div>
      {adding ? (
        <div className="admin-dialog__scrim" onMouseDown={(e) => e.target === e.currentTarget && setAdding(false)}>
          <div
            className="admin-dialog admin-dialog--wide"
            role="dialog"
            aria-modal="true"
            aria-labelledby="addpost-title"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setAdding(false);
              }
            }}
          >
            <h2 className="admin-dialog__title" id="addpost-title">
              Posts in this issue
            </h2>
            {articles === null ? (
              <p className="admin-muted" role="status">
                Loading published posts…
              </p>
            ) : (
              <PostPicker
                articles={articles}
                selected={ids}
                onChange={(next) => {
                  setIds(next);
                  edited();
                }}
                timeZone={timeZone}
              />
            )}
            <div className="admin-dialog__actions">
              <button type="button" className="admin-btn admin-btn--primary" onClick={() => setAdding(false)} autoFocus>
                Done
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </form>
  );
}
