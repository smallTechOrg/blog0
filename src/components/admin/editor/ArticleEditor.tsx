'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

import { fmtDate } from '@/lib/format-date';
import type { DeleteArticleResponse, PublishBlockedDetails, PublishResponse, UnpublishResponse } from '@/lib/api/dto';

import { AdminLoadError } from '../AdminLoad';
import { apiRequest, articleApi, signInHref } from '../api';
import { FORMAT_STATUS_LABEL } from '../labels';
import { HistoryTab } from './HistoryTab';
import { ListenTab } from './ListenTab';
import { PublishBar } from './PublishBar';
import { TldrTab } from './TldrTab';
import { useArticleDoc } from './use-article-doc';
import { WriteTab } from './WriteTab';

// Editor /admin/articles/[id] (spec/ui.md §4). Explicit saves only (every content save is a
// revision); Cmd/Ctrl+S saves; a 409 CONFLICT names the newer revision and offers Reload; the
// textarea never loses typed text on a failed save; beforeunload guards unsaved work.

type TabId = 'write' | 'tldr' | 'listen' | 'history';
const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'write', label: 'Write' },
  { id: 'tldr', label: 'TLDR' },
  { id: 'listen', label: 'Listen' },
  { id: 'history', label: 'History' },
];

export interface ArticleEditorProps {
  articleId: string;
  timeZone: string;
}

export function ArticleEditor({ articleId, timeZone }: ArticleEditorProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | 'publish' | 'unpublish' | 'delete'>(null);
  const [blocked, setBlocked] = useState<PublishBlockedDetails['reasons'] | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const { load, doc, dirty, saveState, conflict, save, adoptArticle, refreshArticle, onField, reload, reloadLatest, close } =
    useArticleDoc(articleId, () => setActionError(null));
  const [tab, setTab] = useState<TabId>('write');
  const [visited, setVisited] = useState<ReadonlySet<TabId>>(() => new Set<TabId>(['write']));
  const selfPath = `/admin/articles/${articleId}`;

  // Cmd/Ctrl+S anywhere on the page saves.
  const saveRef = useRef(save);
  useLayoutEffect(() => {
    saveRef.current = save;
  });
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveRef.current();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Unsaved text → the browser asks before leaving.
  useEffect(() => {
    if (!dirty) return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = '';
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  async function publish(): Promise<void> {
    if (!doc || dirty || busy) return;
    setBusy('publish');
    setBlocked(null);
    setActionError(null);
    const res = await apiRequest<PublishResponse>(articleApi(articleId, 'publish'), {
      method: 'POST',
      body: { revisionId: doc.article.currentRevision.id },
    });
    setBusy(null);
    if (res.ok) {
      adoptArticle(res.data.article);
      return;
    }
    if (res.error.code === 'PUBLISH_BLOCKED') {
      const reasons = (res.error.details as Partial<PublishBlockedDetails> | undefined)?.reasons ?? [];
      setBlocked(reasons.length ? reasons : [{ code: 'BODY_REQUIRED', message: res.error.message }]);
      return;
    }
    setActionError(`Couldn’t publish: ${res.error.message}`);
  }

  async function unpublish(): Promise<void> {
    if (busy || !window.confirm('Unpublish this article? Readers will get “That article isn’t here.” until you publish again.')) return;
    setBusy('unpublish');
    setActionError(null);
    const res = await apiRequest<UnpublishResponse>(articleApi(articleId, 'unpublish'), { method: 'POST' });
    setBusy(null);
    if (res.ok) adoptArticle(res.data.article);
    else setActionError(`Couldn’t unpublish: ${res.error.message}`);
  }

  async function deleteDraft(): Promise<void> {
    if (busy || !window.confirm('Delete this draft and all its revisions? This can’t be undone.')) return;
    setBusy('delete');
    setActionError(null);
    const res = await apiRequest<DeleteArticleResponse>(articleApi(articleId), { method: 'DELETE' });
    if (res.ok) {
      close(); // drops the beforeunload guard before leaving
      router.push('/admin');
      return;
    }
    setBusy(null);
    setActionError(`Couldn’t delete: ${res.error.message}`);
  }

  function confirmReloadLatest(): void {
    if (!window.confirm('Reload the latest version? Your unsaved changes in this editor will be replaced.')) return;
    reloadLatest();
  }

  function selectTab(next: TabId): void {
    if (next === tab) return;
    setTab(next);
    setVisited((prev) => (prev.has(next) ? prev : new Set(prev).add(next)));
  }

  function onTabKey(e: ReactKeyboardEvent<HTMLDivElement>): void {
    const i = TABS.findIndex((t) => t.id === tab);
    let j = -1;
    if (e.key === 'ArrowRight') j = (i + 1) % TABS.length;
    if (e.key === 'ArrowLeft') j = (i - 1 + TABS.length) % TABS.length;
    if (j < 0) return;
    e.preventDefault();
    selectTab(TABS[j].id);
    document.getElementById(`tab-${TABS[j].id}`)?.focus();
  }

  if (load.kind === 'loading') {
    return (
      <main className="desk-main">
        <p className="desk-page admin-muted" role="status">
          Loading the article…
        </p>
      </main>
    );
  }
  if (load.kind === 'error' && load.code === 'NOT_FOUND') {
    return (
      <main className="desk-main">
        <div className="desk-page">
          <h1 className="desk-page__title">That article isn’t here.</h1>
          <p className="admin-muted">It may have been deleted.</p>
          <Link className="admin-btn" href="/admin">
            ← Back to the desk
          </Link>
        </div>
      </main>
    );
  }
  if (load.kind === 'error') {
    return (
      <main className="desk-main">
        <AdminLoadError className="desk-page" error={load} what="the article" onRetry={reload} signInPath={selfPath} />
      </main>
    );
  }

  const { article, fields } = load.data;
  const dateIso = article.firstPublishedAt ?? new Date().toISOString();
  let dateLabel: string;
  try {
    dateLabel = fmtDate(dateIso, timeZone);
  } catch {
    dateLabel = fmtDate(dateIso, 'UTC');
  }
  const tldrChip = article.formats.find((f) => f.kind === 'tldr');
  const listenChip = article.formats.find((f) => f.kind === 'listen');

  return (
    <main className="editor">
      <PublishBar
        article={article}
        title={fields.title}
        dirty={dirty}
        saveState={saveState}
        busy={busy}
        blocked={blocked}
        actionError={actionError}
        signInHref={signInHref(selfPath)}
        onSave={() => void save()}
        onPublish={() => void publish()}
        onUnpublish={() => void unpublish()}
        onDelete={() => void deleteDraft()}
        onDismissBlocked={() => setBlocked(null)}
      />

      {conflict ? (
        <div className="admin-alert editor__conflict" role="alert">
          <p>
            Someone saved a newer version (rev {conflict.number} by {conflict.by}). Reload to continue.
          </p>
          <button type="button" className="admin-btn" onClick={confirmReloadLatest}>
            Reload
          </button>
        </div>
      ) : null}

      <div className="editor__body">
        <div className="modes editor__tabs" role="tablist" aria-label="Editor sections" onKeyDown={onTabKey}>
          {TABS.map((t) => (
            <button
              key={t.id}
              id={`tab-${t.id}`}
              type="button"
              role="tab"
              className={tab === t.id ? 'mode is-on' : 'mode'}
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => selectTab(t.id)}
            >
              {t.label}
              {t.id === 'tldr' && tldrChip ? (
                <span className={`tabchip tabchip--${tldrChip.status}`}>{FORMAT_STATUS_LABEL[tldrChip.status]}</span>
              ) : null}
              {t.id === 'listen' && listenChip ? (
                <span className={`tabchip tabchip--${listenChip.status}`} data-testid="listen-tabchip">
                  {FORMAT_STATUS_LABEL[listenChip.status]}
                </span>
              ) : null}
            </button>
          ))}
        </div>

        <section id="panel-write" role="tabpanel" aria-labelledby="tab-write" hidden={tab !== 'write'}>
          <WriteTab article={article} fields={fields} onField={onField} dateLabel={dateLabel} />
        </section>
        <section id="panel-tldr" role="tabpanel" aria-labelledby="tab-tldr" hidden={tab !== 'tldr'}>
          {visited.has('tldr') ? (
            <TldrTab
              article={article}
              editorDirty={dirty}
              title={fields.title}
              dek={fields.dek}
              topic={fields.topic}
              dateLabel={dateLabel}
              timeZone={timeZone}
              saveFirst={save}
              onArticleChanged={() => void refreshArticle()}
            />
          ) : null}
        </section>
        <section id="panel-listen" role="tabpanel" aria-labelledby="tab-listen" hidden={tab !== 'listen'}>
          {visited.has('listen') ? (
            <ListenTab
              article={article}
              editorDirty={dirty}
              timeZone={timeZone}
              onArticleChanged={() => void refreshArticle()}
              active={tab === 'listen'}
            />
          ) : null}
        </section>
        <section id="panel-history" role="tabpanel" aria-labelledby="tab-history" hidden={tab !== 'history'}>
          <HistoryTab revisionCount={article.revisionCount} />
        </section>
      </div>
    </main>
  );
}
