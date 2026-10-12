'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import type { ArticleDetailDto, PublishBlockedDetails } from '@/lib/api/dto';

// Editor top bar (spec/ui.md §4 PublishBar): ← Desk · title · save state · Save (Cmd/Ctrl+S) ·
// Publish / Publish changes (disabled while unsaved; PUBLISH_BLOCKED reasons in a popover) ·
// View live ↗ · menu (Unpublish, Delete draft). S4.2 takes this file over.

export type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'error'; message: string; signIn: boolean };

export interface PublishBarProps {
  article: ArticleDetailDto;
  title: string;
  dirty: boolean;
  saveState: SaveState;
  busy: null | 'publish' | 'unpublish' | 'delete';
  blocked: PublishBlockedDetails['reasons'] | null;
  actionError: string | null;
  signInHref: string;
  onSave: () => void;
  onPublish: () => void;
  onUnpublish: () => void;
  onDelete: () => void;
  onDismissBlocked: () => void;
}

export function hasThingsToPublish(article: ArticleDetailDto): boolean {
  if (article.status !== 'published') return true;
  return article.publishedRevisionId !== article.currentRevision.id || article.formats.some((f) => f.hasUnpublishedChanges);
}

export function PublishBar(props: PublishBarProps) {
  const { article, title, dirty, saveState, busy, blocked, actionError } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onDoc(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenuOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const published = article.status === 'published';
  const neverPublished = article.firstPublishedAt === null;
  const somethingNew = hasThingsToPublish(article);
  const publishLabel = published ? 'Publish changes' : 'Publish';
  const publishDisabled = dirty || saveState.kind === 'saving' || busy !== null || !somethingNew;
  const publishTitle = dirty ? 'Save first — Publish uses the saved version' : !somethingNew ? 'Nothing new to publish' : undefined;

  let stateText: string;
  if (saveState.kind === 'saving') stateText = 'Saving…';
  else if (saveState.kind === 'error') stateText = 'Couldn’t save';
  else if (dirty) stateText = 'Unsaved changes';
  else stateText = `Saved · rev ${article.currentRevision.number}`;

  return (
    <div className="pubbar">
      <div className="pubbar__in">
        <Link href="/admin" className="pubbar__back">
          ← Desk
        </Link>
        <span className="pubbar__sep" aria-hidden="true" />
        <span className="pubbar__title" title={title}>
          {title || 'Untitled'}
        </span>
        <span
          className={`pubbar__state pubbar__state--${saveState.kind === 'idle' ? (dirty ? 'dirty' : 'saved') : saveState.kind}`}
          role="status"
          aria-live="polite"
        >
          {stateText}
          {saveState.kind === 'error' ? (
            <>
              {' — '}
              <button type="button" className="linkbtn" onClick={props.onSave}>
                Retry
              </button>
            </>
          ) : null}
        </span>

        <div className="pubbar__actions">
          <button
            type="button"
            className="admin-btn"
            onClick={props.onSave}
            disabled={saveState.kind === 'saving' || (!dirty && saveState.kind !== 'error')}
            title="Save (⌘S / Ctrl+S)"
            aria-keyshortcuts="Meta+S Control+S"
          >
            Save
          </button>
          <div className="pubbar__publish">
            <button
              type="button"
              className="admin-btn admin-btn--primary"
              onClick={props.onPublish}
              disabled={publishDisabled}
              title={publishTitle}
              aria-busy={busy === 'publish'}
            >
              {busy === 'publish' ? 'Publishing…' : publishLabel}
            </button>
            {blocked && blocked.length > 0 ? (
              <div className="popover" role="alertdialog" aria-labelledby="publish-blocked-title">
                <p className="popover__title" id="publish-blocked-title">
                  Can’t publish yet
                </p>
                <ul className="popover__list">
                  {blocked.map((r) => (
                    <li key={r.code}>
                      {r.message}
                      {r.sids && r.sids.length > 0 ? (
                        <span className="admin-faint">
                          {' '}
                          ({r.sids.length} {r.sids.length === 1 ? 'line' : 'lines'} — see the TLDR tab)
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
                <button type="button" className="admin-btn admin-btn--small" onClick={props.onDismissBlocked} autoFocus>
                  OK
                </button>
              </div>
            ) : null}
          </div>
          {published && article.publicUrl ? (
            <a className="admin-btn admin-btn--ghost" href={article.publicUrl} target="_blank" rel="noopener noreferrer">
              View live ↗
            </a>
          ) : null}
          {published || neverPublished ? (
            <div className="menu" ref={menuRef}>
              <button
                type="button"
                className="admin-btn admin-btn--ghost admin-btn--icon"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label="More actions"
                onClick={() => setMenuOpen((o) => !o)}
              >
                ⋯
              </button>
              {menuOpen ? (
                <div className="menu__list" role="menu">
                  {published ? (
                    <button
                      type="button"
                      role="menuitem"
                      className="menu__item"
                      disabled={busy !== null}
                      onClick={() => {
                        setMenuOpen(false);
                        props.onUnpublish();
                      }}
                    >
                      Unpublish…
                    </button>
                  ) : null}
                  {neverPublished ? (
                    <button
                      type="button"
                      role="menuitem"
                      className="menu__item menu__item--danger"
                      disabled={busy !== null}
                      onClick={() => {
                        setMenuOpen(false);
                        props.onDelete();
                      }}
                    >
                      Delete draft…
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      {saveState.kind === 'error' || actionError ? (
        <p className="pubbar__error" role="alert">
          {saveState.kind === 'error' ? saveState.message : actionError}
          {saveState.kind === 'error' && saveState.signIn ? (
            <>
              {' '}
              <a href={props.signInHref} target="_blank" rel="noopener noreferrer">
                Sign in in a new tab
              </a>
              , then Retry — your text stays here.
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
