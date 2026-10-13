'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';

import { NEWSLETTER_SETTINGS_LIMITS as L, type ArticleListResponse, type IssueDetailResponse } from '@/lib/api/dto';

import { AdminLoadError, useAdminLoad } from '../AdminLoad';
import { apiRequest, signInHref } from '../api';
import { runExclusive } from '../editor/tldr-generate';

import { postsInvalidMessage, publishedArticles, validateCompose, type ComposeErrors } from './issue-edit';
import { ISSUES_API, ISSUES_PAGE, issueHref } from './newsletter-api';
import { PostPicker } from './PostPicker';

// Admin → Newsletter → New issue /admin/newsletter/new (spec/ui.md §4 "New issue"): title (≤ 150),
// Markdown intro (≤ 5 000), 1–10 published posts in order → Create draft → the issue page.
// Validation inline; ISSUE_POSTS_INVALID names the offending titles. Creating never sends.

const PATH = ISSUES_PAGE + '/new';

const fetchArticles = () => apiRequest<ArticleListResponse>('/api/admin/articles');

export function IssueCompose({ timeZone }: { timeZone: string }) {
  const { load, reload } = useAdminLoad(fetchArticles);

  return (
    <main className="desk-main">
      <div className="desk-page desk-page--narrow">
        <p className="admin-crumb">
          <Link href={ISSUES_PAGE}>← Newsletter</Link>
        </p>
        <h1 className="desk-page__title">New issue</h1>
        {load.kind === 'loading' ? (
          <p className="admin-muted" role="status" aria-live="polite">
            Loading published posts…
          </p>
        ) : null}
        {load.kind === 'error' ? <AdminLoadError error={load} what="the published posts" onRetry={reload} signInPath={PATH} /> : null}
        {load.kind === 'ready' ? <ComposeForm articles={publishedArticles(load.data.articles)} timeZone={timeZone} /> : null}
      </div>
    </main>
  );
}

function ComposeForm({ articles, timeZone }: { articles: ReturnType<typeof publishedArticles>; timeZone: string }) {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [introMd, setIntroMd] = useState('');
  const [articleIds, setArticleIds] = useState<string[]>([]);
  const [errors, setErrors] = useState<ComposeErrors>({});
  const [state, setState] = useState<{ kind: 'idle' } | { kind: 'saving' } | { kind: 'error'; message: string; signedOut: boolean }>({ kind: 'idle' });
  const flight = useRef(false);
  const pending = state.kind === 'saving';

  function onSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    void runExclusive(flight, async () => {
      const fields = { title, introMd, articleIds };
      const found = validateCompose(fields);
      if (Object.keys(found).length) {
        setErrors(found);
        setState({ kind: 'error', message: 'Fix the highlighted fields, then create the draft.', signedOut: false });
        return;
      }
      setErrors({});
      setState({ kind: 'saving' });
      const res = await apiRequest<IssueDetailResponse>(ISSUES_API, {
        method: 'POST',
        body: { title: title.trim(), introMd, articleIds },
      });
      if (res.ok) {
        router.push(issueHref(res.data.issue.id));
        return;
      }
      if (res.error.code === 'ISSUE_POSTS_INVALID') {
        setErrors({ articleIds: postsInvalidMessage(res.error.details, articles) ?? res.error.message });
      }
      setState({ kind: 'error', message: res.error.message, signedOut: res.error.code === 'UNAUTHENTICATED' });
    });
  }

  return (
    <form className="admin-form" onSubmit={onSubmit} noValidate aria-label="New issue">
      <div className="admin-field">
        <label className="admin-label" htmlFor="issue-title">
          Title
        </label>
        <input
          id="issue-title"
          className="admin-input"
          value={title}
          maxLength={L.issueTitle}
          disabled={pending}
          onChange={(e) => setTitle(e.target.value)}
          aria-invalid={errors.title ? true : undefined}
          aria-describedby={errors.title ? 'issue-title-err' : undefined}
          autoComplete="off"
          required
        />
        {errors.title ? (
          <span className="admin-error" id="issue-title-err">
            {errors.title}
          </span>
        ) : null}
      </div>
      <div className="admin-field">
        <label className="admin-label" htmlFor="issue-intro">
          Intro <span className="admin-faint">(optional)</span>
        </label>
        <textarea
          id="issue-intro"
          className="admin-input"
          rows={5}
          value={introMd}
          maxLength={L.issueIntroMd}
          disabled={pending}
          onChange={(e) => setIntroMd(e.target.value)}
          aria-invalid={errors.introMd ? true : undefined}
          aria-describedby={'issue-intro-hint' + (errors.introMd ? ' issue-intro-err' : '')}
        />
        <span className="admin-hint" id="issue-intro-hint">
          Paragraphs, emphasis and links only.
        </span>
        {errors.introMd ? (
          <span className="admin-error" id="issue-intro-err">
            {errors.introMd}
          </span>
        ) : null}
      </div>
      <fieldset className="admin-field nl-posts" disabled={pending}>
        <legend className="admin-label">Posts</legend>
        <PostPicker articles={articles} selected={articleIds} onChange={setArticleIds} timeZone={timeZone} disabled={pending} />
        {errors.articleIds ? (
          <span className="admin-error" role="alert">
            {errors.articleIds}
          </span>
        ) : null}
      </fieldset>
      <div className="admin-form__actions">
        <button type="submit" className="admin-btn admin-btn--primary" disabled={pending} aria-busy={pending}>
          {pending ? 'Creating…' : 'Create draft'}
        </button>
        <Link href={ISSUES_PAGE} className="admin-btn admin-btn--ghost">
          Cancel
        </Link>
      </div>
      <div aria-live="polite">
        {state.kind === 'error' ? (
          <p className="admin-error" role="alert">
            {state.signedOut ? (
              <>
                Your session ended — <a href={signInHref(PATH)}>sign in again</a> (copy your text first).
              </>
            ) : (
              state.message
            )}
          </p>
        ) : null}
      </div>
    </form>
  );
}
