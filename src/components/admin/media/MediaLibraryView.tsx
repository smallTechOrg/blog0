'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import type { MediaLibraryItemDto } from '@/lib/api/dto';
import { copyToClipboard } from '@/components/reader/clipboard';

import { AdminLoadError, stamped, useAdminLoad } from '../AdminLoad';
import { relativeTime } from '../relative-time';
import { IMAGES_ONLY_NOTICE, isAcceptedImage } from '../editor/insert-image';
import { ACCEPT_IMAGES } from '../editor/ImageUploadButton';

import { articleHref, detailLine, filterItems, listMedia, markdownFor, MEDIA_PAGE, replaceMedia } from './media-api';

// Admin → Media /admin/media (spec/ui.md §4 "Media"; capability media-library): a grid of every
// uploaded image — thumbnail, size, who uploaded it and when, the articles that show it — with
// Copy Markdown, Copy link and Replace. Replacing keeps the image's address, so every article
// that uses it shows the new file on its next view (nothing is edited).

export interface MediaLibraryViewProps {
  timeZone: string;
}

export function MediaLibraryView({ timeZone }: MediaLibraryViewProps) {
  const { load: state, setLoad, reload } = useAdminLoad(() => stamped(listMedia()));
  const [query, setQuery] = useState('');
  // Bumped per image after a replace, so the browser fetches the thumbnail again.
  const [versions, setVersions] = useState<Record<string, number>>({});
  const ready = state.kind === 'ready' ? state.data : null;
  const shown = ready ? filterItems(ready.items, query) : [];

  function replaced(item: MediaLibraryItemDto): void {
    setVersions((v) => ({ ...v, [item.id]: (v[item.id] ?? 0) + 1 }));
    setLoad((s) => (s.kind === 'ready' ? { kind: 'ready', data: { ...s.data, items: s.data.items.map((i) => (i.id === item.id ? item : i)) } } : s));
  }

  return (
    <main className="desk-main">
      <div className="desk-page">
        <div className="desk-page__head">
          <h1 className="desk-page__title">
            Media
            {ready ? <span className="admin-faint"> · {ready.items.length}</span> : null}
          </h1>
        </div>
        <p className="admin-hint medlib__intro">
          Every image uploaded through the editor. Replace a file and every article that uses it shows the new one — the address stays the
          same. Images are added from an article’s editor (the Image button, or paste Markdown that includes them).
        </p>

        {ready && ready.items.length > 0 ? (
          <label className="medlib__search">
            <span className="sr">Filter images</span>
            <input
              type="search"
              className="admin-input"
              placeholder="Filter by name or article"
              value={query}
              maxLength={100}
              onChange={(e) => setQuery(e.target.value)}
              autoComplete="off"
            />
          </label>
        ) : null}

        {state.kind === 'loading' ? (
          <p className="admin-muted" role="status" aria-live="polite">
            Loading images…
          </p>
        ) : null}
        {state.kind === 'error' ? <AdminLoadError error={state} what="the images" onRetry={reload} signInPath={MEDIA_PAGE} /> : null}

        {ready && ready.items.length === 0 ? (
          <div className="desk-empty">
            <p>No images yet. Add one with the Image button in an article’s editor, or paste Markdown that includes images.</p>
          </div>
        ) : null}
        {ready && ready.items.length > 0 && shown.length === 0 ? (
          <div className="desk-empty">
            <p>No image matches “{query.trim()}”.</p>
          </div>
        ) : null}

        {ready && shown.length > 0 ? (
          <ul className="medlib" aria-label="Images">
            {shown.map((item) => (
              <MediaCard key={item.id} item={item} now={ready.now} timeZone={timeZone} version={versions[item.id] ?? 0} onReplaced={replaced} />
            ))}
          </ul>
        ) : null}
      </div>
    </main>
  );
}

interface MediaCardProps {
  item: MediaLibraryItemDto;
  now: Date;
  timeZone: string;
  version: number;
  onReplaced: (item: MediaLibraryItemDto) => void;
}

function MediaCard({ item, now, timeZone, version, onReplaced }: MediaCardProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState<'md' | 'link' | 'failed' | null>(null);
  const [pending, setPending] = useState<{ file: File; thumb: string | null } | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const src = version > 0 ? `${item.url}?v=${version}` : item.url;

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(null), 1800);
    return () => window.clearTimeout(t);
  }, [copied]);

  // The preview URL of a file chosen for replacing is released when it leaves the card.
  useEffect(() => {
    const thumb = pending?.thumb;
    return () => {
      if (thumb) URL.revokeObjectURL(thumb);
    };
  }, [pending]);

  async function copy(kind: 'md' | 'link'): Promise<void> {
    const text = kind === 'md' ? markdownFor(item) : window.location.origin + item.url;
    setCopied((await copyToClipboard(text)) ? kind : 'failed');
  }

  function choose(file: File | undefined): void {
    if (!file) return;
    setError(null);
    if (!isAcceptedImage(file)) {
      setError(IMAGES_ONLY_NOTICE);
      return;
    }
    let thumb: string | null = null;
    try {
      thumb = URL.createObjectURL(file);
    } catch {
      thumb = null;
    }
    setPending({ file, thumb });
  }

  async function confirmReplace(): Promise<void> {
    if (!pending) return;
    setError(null);
    setProgress(0);
    const res = await replaceMedia(item.id, pending.file, { onProgress: (p) => setProgress(p.total > 0 ? Math.min(100, Math.round((p.loaded / p.total) * 100)) : 0) });
    setProgress(null);
    if (res.ok) {
      setPending(null);
      onReplaced(res.data.item);
      return;
    }
    setError(res.error.message);
  }

  const busy = progress !== null;
  const used = item.usedIn;

  return (
    <li className="medcard" data-testid="media-card">
      <div className="medcard__thumb">
        {/* Admin thumbnail of an uploaded file; next/image would only re-encode it. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt="" loading="lazy" width={item.width ?? undefined} height={item.height ?? undefined} />
      </div>
      <div className="medcard__body">
        <p className="medcard__name" title={item.filename}>
          {item.filename}
        </p>
        <p className="admin-faint medcard__meta mono">{detailLine(item)}</p>
        <p className="admin-faint medcard__meta">
          Uploaded {relativeTime(item.createdAt, now, timeZone)} by {item.uploadedBy}
        </p>
        <div className="medcard__used">
          {used.length === 0 ? (
            <span className="admin-faint">Not used in any article</span>
          ) : (
            <>
              <span className="admin-faint">Used in</span>
              <ul>
                {used.map((u) => (
                  <li key={u.articleId}>
                    <Link href={articleHref(u.articleId)}>{u.title || u.slug}</Link>
                    {u.status === 'draft' ? <span className="admin-faint"> · draft</span> : null}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        {pending ? (
          <div className="medcard__confirm" role="group" aria-label={`Replace ${item.filename}`}>
            {pending.thumb ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="medcard__newthumb" src={pending.thumb} alt="" />
            ) : null}
            <p className="admin-hint">
              Replace with <b>{pending.file.name}</b>?{' '}
              {used.length > 0 ? `${used.length === 1 ? 'The article' : `All ${used.length} articles`} using this image will show the new one.` : 'No article uses this image yet.'}
            </p>
            <div className="admin-actions">
              <button type="button" className="admin-btn admin-btn--primary admin-btn--small" disabled={busy} aria-busy={busy} onClick={() => void confirmReplace()} data-testid="media-confirm">
                {busy ? `Replacing… ${progress}%` : 'Replace'}
              </button>
              <button type="button" className="admin-btn admin-btn--ghost admin-btn--small" disabled={busy} onClick={() => { setPending(null); setError(null); }}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="admin-actions medcard__actions">
            <button type="button" className="admin-btn admin-btn--small" onClick={() => void copy('md')}>
              {copied === 'md' ? 'Copied' : 'Copy Markdown'}
            </button>
            <button type="button" className="admin-btn admin-btn--small" onClick={() => void copy('link')}>
              {copied === 'link' ? 'Copied' : 'Copy link'}
            </button>
            <button type="button" className="admin-btn admin-btn--small" onClick={() => inputRef.current?.click()} data-testid="media-replace">
              Replace…
            </button>
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPT_IMAGES}
              hidden
              data-testid="media-replace-input"
              onChange={(e) => {
                choose(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </div>
        )}
        {copied === 'failed' ? (
          <p className="admin-error" role="alert">
            Couldn’t copy — select the address yourself: <span className="mono">{item.url}</span>
          </p>
        ) : null}
        {error ? (
          <p className="admin-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </li>
  );
}
