'use client';

import { useEffect, useImperativeHandle, useRef, useState, type FormEvent, type Ref } from 'react';

import { uploadImage } from '../listen/listen-api';

import { ALT_MAX, CAPTION_MAX, IMAGES_ONLY_NOTICE, altFromFilename, imageSnippet, isAcceptedImage } from './insert-image';

// Editor Image button (spec/ui.md §4 Editor → Image; capability media-images). Lives in the
// MarkdownEditor's `.mdedit__tools` slot. Picked or dropped files queue in order; each opens the
// "Add image" dialog (thumbnail, Alt text pre-filled from the filename, optional Caption), then
// uploads by XHR with progress on the button label. When the upload starts, `onBegin` marks the
// caret (the editor tracks it through edits); success hands the snippet and that mark to
// `onInsert`, so the image lands where the cursor was when the upload started; errors show
// inline with Try again (same mark); Skip releases it.

export const ACCEPT_IMAGES = 'image/png,image/jpeg,image/webp,image/gif';
export const EMPTY_ALT_NOTE = 'Empty alt marks the image decorative';

export interface ImageUploadHandle {
  /** Queue files (drag-and-drop on the textarea); non-images are dropped with a short notice. */
  addFiles: (files: File[]) => void;
}

export interface ImageUploadButtonProps {
  articleId: string;
  /** An upload is starting: remember the caret; returns the mark handed back to onInsert / onRelease. */
  onBegin?: () => number;
  onInsert: (snippet: string, mark: number | null) => void;
  /** The upload was abandoned (Skip after a failure): forget its mark. */
  onRelease?: (mark: number) => void;
  disabled?: boolean;
  ref?: Ref<ImageUploadHandle>;
}

type Queued = { file: File; /** Object URL for the dialog thumbnail (revoked when the item leaves the queue). */ thumb: string | null };
type Pending = { item: Queued; alt: string; caption: string; /** Caret mark taken when the upload first started. */ mark?: number | null };
type Failure = { message: string; job: Pending };

export function ImageUploadButton({ articleId, onBegin, onInsert, onRelease, disabled, ref }: ImageUploadButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [queue, setQueue] = useState<Queued[]>([]);
  const [progress, setProgress] = useState<number | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inFlight = useRef(false);

  const current = progress === null && failure === null ? (queue[0] ?? null) : null;

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 2000);
    return () => window.clearTimeout(t);
  }, [notice]);

  function addFiles(files: File[]): void {
    const ok = files.filter(isAcceptedImage);
    if (ok.length < files.length) setNotice(IMAGES_ONLY_NOTICE);
    if (ok.length) setQueue((q) => [...q, ...ok.map((file) => ({ file, thumb: thumbUrl(file) }))]);
  }

  function drop(item: Queued): void {
    if (item.thumb) URL.revokeObjectURL(item.thumb);
    setQueue((q) => q.filter((x) => x !== item));
  }

  useImperativeHandle(ref, () => ({ addFiles }));

  async function send(pending: Pending): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    const job: Pending = pending.mark === undefined ? { ...pending, mark: onBegin ? onBegin() : null } : pending;
    setFailure(null);
    setProgress(0);
    const res = await uploadImage(
      job.item.file,
      { alt: job.alt, caption: job.caption, articleId },
      { onProgress: (p) => setProgress(p.total > 0 ? Math.min(100, Math.round((p.loaded / p.total) * 100)) : 0) },
    );
    inFlight.current = false;
    setProgress(null);
    if (res.ok) {
      const snippet = res.data.markdown || imageSnippet(job.alt, res.data.asset.url, job.caption);
      drop(job.item);
      onInsert(snippet, job.mark ?? null);
      return;
    }
    setFailure({ message: res.error.message, job });
  }

  function cancel(item: Queued): void {
    drop(item);
    buttonRef.current?.focus();
  }

  function dismissFailure(): void {
    if (!failure) return;
    setFailure(null);
    if (failure.job.mark !== undefined && failure.job.mark !== null) onRelease?.(failure.job.mark);
    drop(failure.job.item);
  }

  const uploading = progress !== null;
  const label = uploading ? `Uploading… ${progress}%` : 'Image';

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_IMAGES}
        multiple
        hidden
        data-testid="image-file-input"
        onChange={(e) => {
          addFiles(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
      <button
        ref={buttonRef}
        type="button"
        className="admin-btn admin-btn--small"
        disabled={disabled || uploading}
        aria-busy={uploading}
        onClick={() => inputRef.current?.click()}
        data-testid="image-button"
      >
        {label}
      </button>
      {notice ? (
        <p className="admin-hint mdedit__note" role="status">
          {notice}
        </p>
      ) : null}
      {failure ? (
        <p className="admin-error mdedit__note" role="alert">
          Couldn’t upload “{failure.job.item.file.name}”: {failure.message}{' '}
          <button type="button" className="linkbtn" onClick={() => void send(failure.job)}>
            Try again
          </button>{' '}
          ·{' '}
          <button type="button" className="linkbtn" onClick={dismissFailure}>
            Skip
          </button>
        </p>
      ) : null}

      {current ? (
        <ImageDialog
          key={current.thumb ?? current.file.name + current.file.lastModified}
          item={current}
          queued={queue.length - 1}
          onInsert={(alt, caption) => void send({ item: current, alt, caption })}
          onCancel={() => cancel(current)}
        />
      ) : null}
    </>
  );
}

function thumbUrl(file: File): string | null {
  try {
    return URL.createObjectURL(file);
  } catch {
    return null;
  }
}

interface ImageDialogProps {
  item: Queued;
  queued: number;
  onInsert: (alt: string, caption: string) => void;
  onCancel: () => void;
}

/** The "Add image" prompt for one file (keyed per file, so its fields start fresh). */
function ImageDialog({ item, queued, onInsert, onCancel }: ImageDialogProps) {
  const [alt, setAlt] = useState(() => altFromFilename(item.file.name));
  const [caption, setCaption] = useState('');

  function submit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    onInsert(alt.trim(), caption.trim());
  }

  return (
    <div className="admin-dialog__scrim" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <form
        className="admin-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="imgdlg-title"
        onSubmit={submit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
      >
        <h2 className="admin-dialog__title" id="imgdlg-title">
          Add image
        </h2>
        {/* A local blob: preview of the chosen file — next/image can't optimise object URLs. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {item.thumb ? <img className="admin-dialog__thumb" src={item.thumb} alt="" /> : null}
        <p className="admin-hint admin-dialog__file mono">
          {item.file.name}
          {queued > 0 ? ` · ${queued} more queued` : ''}
        </p>
        <label className="admin-field">
          <span className="admin-label">Alt text</span>
          <input
            className="admin-input"
            value={alt}
            maxLength={ALT_MAX}
            onChange={(e) => setAlt(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            aria-describedby="imgdlg-alt-note"
            data-testid="image-alt"
            autoFocus
          />
          <span className="admin-hint" id="imgdlg-alt-note">
            {alt.trim() === '' ? EMPTY_ALT_NOTE : 'Describe the image for readers who can’t see it.'}
          </span>
        </label>
        <label className="admin-field">
          <span className="admin-label">
            Caption <span className="admin-faint">(optional)</span>
          </span>
          <input className="admin-input" value={caption} maxLength={CAPTION_MAX} onChange={(e) => setCaption(e.target.value)} />
        </label>
        <div className="admin-dialog__actions">
          <button type="submit" className="admin-btn admin-btn--primary" data-testid="image-insert">
            Insert
          </button>
          <button type="button" className="admin-btn admin-btn--ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
