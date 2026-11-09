'use client';

import { useCallback, useLayoutEffect, useRef, useState } from 'react';

import type { ArticleDetailDto, GetArticleResponse, UpdateArticleResponse } from '@/lib/api/dto';

import { useAdminLoad, type AdminLoad } from '../AdminLoad';
import { apiRequest, articleApi, type ApiResult } from '../api';
import { changedFields, fieldsFrom, mergeAfterSave, type EditorFields } from './fields';
import type { SaveState } from './PublishBar';

// The editor's document (spec/ui.md §4 Editor): the server article + the writer's fields, explicit
// saves (every content save is a revision), and the 409 CONFLICT that names the newer revision.
// A failed save never drops typed text.

export interface ArticleDoc {
  article: ArticleDetailDto;
  fields: EditorFields;
}

export type Conflict = { number: number; by: string } | null;

async function fetchDoc(articleId: string): Promise<ApiResult<ArticleDoc>> {
  const res = await apiRequest<GetArticleResponse>(articleApi(articleId));
  return res.ok ? { ...res, data: { article: res.data.article, fields: fieldsFrom(res.data.article) } } : res;
}

/** `onSaving` runs when a save actually goes out (the editor clears its action error then). */
export function useArticleDoc(articleId: string, onSaving?: () => void) {
  const { load, setLoad, reload } = useAdminLoad(() => fetchDoc(articleId), articleId);
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  const [conflict, setConflict] = useState<Conflict>(null);
  const loadRef = useRef<AdminLoad<ArticleDoc>>(load);
  const savingRef = useRef(false);
  const onSavingRef = useRef(onSaving);
  useLayoutEffect(() => {
    loadRef.current = load;
    onSavingRef.current = onSaving;
  });

  const doc = load.kind === 'ready' ? load.data : null;
  const dirty = doc !== null && Object.keys(changedFields(doc.article, doc.fields)).length > 0;

  /** Server article changed underneath (deck save, publish…): adopt it, keep the writer's edits. */
  const adoptArticle = useCallback(
    (next: ArticleDetailDto) => {
      setLoad((prev) => {
        if (prev.kind !== 'ready') return { kind: 'ready', data: { article: next, fields: fieldsFrom(next) } };
        const { article, fields } = prev.data;
        return { kind: 'ready', data: { article: next, fields: mergeAfterSave(fieldsFrom(article), fields, next) } };
      });
    },
    [setLoad],
  );

  const refreshArticle = useCallback(async () => {
    const res = await apiRequest<GetArticleResponse>(articleApi(articleId));
    if (res.ok) adoptArticle(res.data.article);
  }, [articleId, adoptArticle]);

  const onField = useCallback(
    <K extends keyof EditorFields>(key: K, value: EditorFields[K]) => {
      setLoad((prev) => (prev.kind === 'ready' ? { kind: 'ready', data: { ...prev.data, fields: { ...prev.data.fields, [key]: value } } } : prev));
      setSaveState((s) => (s.kind === 'error' ? s : { kind: 'idle' }));
    },
    [setLoad],
  );

  /** Saves the changed fields; resolves to the saved article, or null when nothing could be saved. */
  const save = useCallback(async (): Promise<ArticleDetailDto | null> => {
    const current = loadRef.current;
    if (current.kind !== 'ready' || savingRef.current) return null;
    const patch = changedFields(current.data.article, current.data.fields);
    if (Object.keys(patch).length === 0) {
      setSaveState({ kind: 'idle' });
      return current.data.article;
    }
    const sent = current.data.fields;
    savingRef.current = true;
    setSaveState({ kind: 'saving' });
    onSavingRef.current?.();
    const res = await apiRequest<UpdateArticleResponse>(articleApi(articleId), {
      method: 'PATCH',
      body: { baseRevisionId: current.data.article.currentRevision.id, ...patch },
    });
    savingRef.current = false;

    if (res.ok) {
      const next = res.data.article;
      setLoad((prev) =>
        prev.kind === 'ready' ? { kind: 'ready', data: { article: next, fields: mergeAfterSave(sent, prev.data.fields, next) } } : prev,
      );
      setSaveState({ kind: 'idle' });
      return next;
    }
    if (res.error.code === 'CONFLICT') {
      const latest = await apiRequest<GetArticleResponse>(articleApi(articleId));
      const rev = latest.ok ? latest.data.article.currentRevision : null;
      setConflict({ number: rev?.number ?? 0, by: rev?.createdBy ?? 'someone' });
      setSaveState({ kind: 'error', message: 'Someone saved a newer version — see above.', signIn: false });
      return null;
    }
    setSaveState({ kind: 'error', message: res.error.message, signIn: res.error.code === 'UNAUTHENTICATED' });
    return null;
  }, [articleId, setLoad]);

  /** After a conflict: drop the writer's copy and load the latest revision. */
  const reloadLatest = useCallback(() => {
    setConflict(null);
    setSaveState({ kind: 'idle' });
    reload();
  }, [reload]);

  /** Forget the document (drops the beforeunload guard before leaving the page). */
  const close = useCallback(() => setLoad({ kind: 'loading' }), [setLoad]);

  return { load, doc, dirty, saveState, conflict, save, adoptArticle, refreshArticle, onField, reload, reloadLatest, close };
}
