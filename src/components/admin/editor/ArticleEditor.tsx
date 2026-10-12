'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

import { fmtDate } from '@/lib/format-date';
import type {
  ArticleDetailDto,
  DeleteArticleResponse,
  GetArticleResponse,
  PublishBlockedDetails,
  PublishResponse,
  UnpublishResponse,
  UpdateArticleResponse,
} from '@/lib/api/dto';

import { apiRequest, signInHref } from '../api';
import { FORMAT_STATUS_LABEL } from '../labels';
import { changedFields, fieldsFrom, mergeAfterSave, type EditorFields } from './fields';
import { HistoryTab } from './HistoryTab';
import { ListenTab } from './ListenTab';
import { PublishBar, type SaveState } from './PublishBar';
import { TldrTab } from './TldrTab';
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

type Load =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'error'; message: string; signIn: boolean }
  | { kind: 'ready'; article: ArticleDetailDto; fields: EditorFields };

const LEAVE_MARKS_CONFIRM = 'You have unsaved Listen marks. Leave the Listen tab anyway? They stay here until you reload.';

type Conflict = { number: number; by: string } | null;

export interface ArticleEditorProps {
  articleId: string;
  timeZone: string;
}

export function ArticleEditor({ articleId, timeZone }: ArticleEditorProps) {
  const router = useRouter();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  const [conflict, setConflict] = useState<Conflict>(null);
  const [busy, setBusy] = useState<null | 'publish' | 'unpublish' | 'delete'>(null);
  const [blocked, setBlocked] = useState<PublishBlockedDetails['reasons'] | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>('write');
  const [visited, setVisited] = useState<ReadonlySet<TabId>>(() => new Set<TabId>(['write']));
  const [reloadTick, setReloadTick] = useState(0);
  const [marksDirty, setMarksDirty] = useState(false);

  const loadRef = useRef(load);
  const savingRef = useRef(false);
  const selfPath = `/admin/articles/${articleId}`;

  useLayoutEffect(() => {
    loadRef.current = load;
  });

  useEffect(() => {
    let live = true;
    void apiRequest<GetArticleResponse>(`/api/admin/articles/${encodeURIComponent(articleId)}`).then((res) => {
      if (!live) return;
      if (res.ok) setLoad({ kind: 'ready', article: res.data.article, fields: fieldsFrom(res.data.article) });
      else if (res.error.code === 'NOT_FOUND') setLoad({ kind: 'missing' });
      else setLoad({ kind: 'error', message: res.error.message, signIn: res.error.code === 'UNAUTHENTICATED' });
    });
    return () => {
      live = false;
    };
  }, [articleId, reloadTick]);

  const dirty = load.kind === 'ready' && Object.keys(changedFields(load.article, load.fields)).length > 0;

  /** Server article changed underneath (deck save, publish…): adopt it, keep the writer's edits. */
  const adoptArticle = useCallback((next: ArticleDetailDto) => {
    setLoad((prev) => {
      if (prev.kind !== 'ready') return { kind: 'ready', article: next, fields: fieldsFrom(next) };
      return { kind: 'ready', article: next, fields: mergeAfterSave(fieldsFrom(prev.article), prev.fields, next) };
    });
  }, []);

  const refreshArticle = useCallback(async () => {
    const res = await apiRequest<GetArticleResponse>(`/api/admin/articles/${articleId}`);
    if (res.ok) adoptArticle(res.data.article);
  }, [articleId, adoptArticle]);

  const save = useCallback(async (): Promise<ArticleDetailDto | null> => {
    const current = loadRef.current;
    if (current.kind !== 'ready' || savingRef.current) return null;
    const patch = changedFields(current.article, current.fields);
    if (Object.keys(patch).length === 0) {
      setSaveState({ kind: 'idle' });
      return current.article;
    }
    const sent = current.fields;
    savingRef.current = true;
    setSaveState({ kind: 'saving' });
    setActionError(null);
    const res = await apiRequest<UpdateArticleResponse>(`/api/admin/articles/${articleId}`, {
      method: 'PATCH',
      body: { baseRevisionId: current.article.currentRevision.id, ...patch },
    });
    savingRef.current = false;

    if (res.ok) {
      const next = res.data.article;
      setLoad((prev) => (prev.kind === 'ready' ? { kind: 'ready', article: next, fields: mergeAfterSave(sent, prev.fields, next) } : prev));
      setSaveState({ kind: 'idle' });
      return next;
    }
    if (res.error.code === 'CONFLICT') {
      const latest = await apiRequest<GetArticleResponse>(`/api/admin/articles/${articleId}`);
      const rev = latest.ok ? latest.data.article.currentRevision : null;
      setConflict({ number: rev?.number ?? 0, by: rev?.createdBy ?? 'someone' });
      setSaveState({ kind: 'error', message: 'Someone saved a newer version — see above.', signIn: false });
      return null;
    }
    setSaveState({ kind: 'error', message: res.error.message, signIn: res.error.code === 'UNAUTHENTICATED' });
    return null;
  }, [articleId]);

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

  // Unsaved work (text or Listen marks) → the browser asks before leaving.
  const leaveGuard = dirty || marksDirty;
  useEffect(() => {
    if (!leaveGuard) return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = '';
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [leaveGuard]);

  const onField = useCallback(<K extends keyof EditorFields>(key: K, value: EditorFields[K]) => {
    setLoad((prev) => (prev.kind === 'ready' ? { ...prev, fields: { ...prev.fields, [key]: value } } : prev));
    setSaveState((s) => (s.kind === 'error' ? s : { kind: 'idle' }));
  }, []);

  async function publish(): Promise<void> {
    if (load.kind !== 'ready' || dirty || busy) return;
    setBusy('publish');
    setBlocked(null);
    setActionError(null);
    const res = await apiRequest<PublishResponse>(`/api/admin/articles/${articleId}/publish`, {
      method: 'POST',
      body: { revisionId: load.article.currentRevision.id },
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
    const res = await apiRequest<UnpublishResponse>(`/api/admin/articles/${articleId}/unpublish`, { method: 'POST' });
    setBusy(null);
    if (res.ok) adoptArticle(res.data.article);
    else setActionError(`Couldn’t unpublish: ${res.error.message}`);
  }

  async function deleteDraft(): Promise<void> {
    if (busy || !window.confirm('Delete this draft and all its revisions? This can’t be undone.')) return;
    setBusy('delete');
    setActionError(null);
    const res = await apiRequest<DeleteArticleResponse>(`/api/admin/articles/${articleId}`, { method: 'DELETE' });
    if (res.ok) {
      setLoad({ kind: 'loading' }); // drops the beforeunload guard before leaving
      router.push('/admin');
      return;
    }
    setBusy(null);
    setActionError(`Couldn’t delete: ${res.error.message}`);
  }

  function reloadLatest(): void {
    if (!window.confirm('Reload the latest version? Your unsaved changes in this editor will be replaced.')) return;
    setConflict(null);
    setSaveState({ kind: 'idle' });
    setLoad({ kind: 'loading' });
    setReloadTick((n) => n + 1);
  }

  function selectTab(next: TabId): void {
    if (next === tab) return;
    if (tab === 'listen' && marksDirty && !window.confirm(LEAVE_MARKS_CONFIRM)) return;
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
    if (tab === 'listen' && marksDirty && !window.confirm(LEAVE_MARKS_CONFIRM)) return;
    setTab(TABS[j].id);
    setVisited((prev) => (prev.has(TABS[j].id) ? prev : new Set(prev).add(TABS[j].id)));
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
  if (load.kind === 'missing') {
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
        <div className="desk-page admin-alert" role="alert">
          <p>Couldn’t load the article: {load.message}</p>
          {load.signIn ? (
            <a className="admin-btn" href={signInHref(selfPath)}>
              Sign in again
            </a>
          ) : (
            <button type="button" className="admin-btn" onClick={() => setReloadTick((n) => n + 1)}>
              Retry
            </button>
          )}
        </div>
      </main>
    );
  }

  const { article, fields } = load;
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
        marksDirty={marksDirty}
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
        onGoToListen={() => {
          setBlocked(null);
          selectTab('listen');
        }}
      />

      {conflict ? (
        <div className="admin-alert editor__conflict" role="alert">
          <p>
            Someone saved a newer version (rev {conflict.number} by {conflict.by}). Reload to continue.
          </p>
          <button type="button" className="admin-btn" onClick={reloadLatest}>
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
              {t.id === 'listen' && listenChip && listenChip.status !== 'unavailable' ? (
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
              saveFirst={save}
              onArticleChanged={() => void refreshArticle()}
              onSelectTab={selectTab}
              onMarksDirty={setMarksDirty}
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
