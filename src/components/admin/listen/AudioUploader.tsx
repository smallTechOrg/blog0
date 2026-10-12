'use client';

import { useRef, useState, type DragEvent, type ReactNode, type RefObject } from 'react';

import type { ListenAudioDto, ListenResponse } from '@/lib/api/dto-phase3';
import { fmtClock } from '@/lib/listen/marks';

import type { ApiResult } from '../api';
import { relativeTime } from '../relative-time';

import { fmtMb, uploadAudio } from './listen-api';

// Recording column of the Listen tab (spec/ui.md §4 Listen tab → Recording): dropzone + file
// picker, XHR progress with Cancel, inline errors with Try again, and — once a recording exists —
// the player, the file line, Replace… and Remove audio.

export const ACCEPT_AUDIO = 'audio/mpeg,audio/mp4,audio/x-m4a,.mp3,.m4a';

export interface AudioUploaderProps {
  articleId: string;
  audio: ListenAudioDto | null;
  limits: { maxAudioMb: number; maxAudioMinutes: number };
  /** Marks in the working set — Replace… confirms when any exist. */
  markCount: number;
  audioRef: RefObject<HTMLAudioElement | null>;
  /** Anything else to show under the player (file line, etc. are built in). */
  children?: ReactNode;
  timeZone: string;
  /** Reference time for "uploaded <relative time>" (the tab refreshes it with each server state). */
  now: Date;
  disabled?: boolean;
  /** Focus the dropzone / picker (stale banner's "Upload a new recording"). */
  focusRef?: RefObject<HTMLButtonElement | null>;
  /** Player events the tab follows (clock, live row, "recording ended"). */
  playerEvents?: { onPlay?: () => void; onPause?: () => void; onEnded?: () => void; onSeeked?: () => void };
  onUploaded: (res: ListenResponse) => void;
  onRemove: () => Promise<ApiResult<ListenResponse>>;
  onRemoved: (res: ListenResponse) => void;
}

type Upload = { file: File; loaded: number; total: number; controller: AbortController };

export const CONFIRM_REPLACE = (n: number) => `Replace the recording? Your ${n} ${n === 1 ? 'mark' : 'marks'} will be cleared.`;
export const CONFIRM_REMOVE = 'Remove the recording and its marks? The published Listen keeps serving until you publish again.';

const AUDIO_TYPES: ReadonlySet<string> = new Set(['audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/aac', 'audio/x-aac']);

/**
 * Client-side pre-filter only (the server content-probes every upload): a known audio MIME, or —
 * since browsers report m4a as audio/m4a, audio/aac, audio/x-m4a or nothing at all — an .mp3 /
 * .m4a name whatever the reported type.
 */
export function looksLikeAudio(file: { type: string; name: string }): boolean {
  if (file.type && AUDIO_TYPES.has(file.type.toLowerCase())) return true;
  return /\.(mp3|m4a)$/i.test(file.name);
}

export function AudioUploader(props: AudioUploaderProps) {
  const { articleId, audio, limits, markCount, audioRef, timeZone, now, disabled, focusRef, playerEvents, onUploaded, onRemove, onRemoved } = props;
  const inputRef = useRef<HTMLInputElement>(null);
  const [upload, setUpload] = useState<Upload | null>(null);
  const [error, setError] = useState<{ message: string; file: File | null } | null>(null);
  const [dropping, setDropping] = useState(false);
  const [removing, setRemoving] = useState(false);
  const inFlight = useRef(false);

  async function send(file: File): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    const controller = new AbortController();
    setUpload({ file, loaded: 0, total: file.size, controller });
    const res = await uploadAudio(articleId, file, {
      signal: controller.signal,
      onProgress: (p) => setUpload((u) => (u && u.file === file ? { ...u, loaded: p.loaded, total: p.total || u.total } : u)),
    });
    inFlight.current = false;
    setUpload(null);
    if (res.ok) {
      onUploaded(res.data);
      return;
    }
    if (res.error.code === 'ABORTED') return;
    setError({ message: res.error.message, file });
  }

  function choose(files: FileList | File[] | null): void {
    const file = files && files.length > 0 ? files[0] : null;
    if (!file || disabled || upload) return;
    if (!looksLikeAudio(file)) {
      setError({ message: `“${file.name}” doesn’t look like an mp3 or m4a. Choose a recording in one of those formats.`, file: null });
      return;
    }
    if (audio && markCount > 0 && !window.confirm(CONFIRM_REPLACE(markCount))) return;
    void send(file);
  }

  function onDrop(e: DragEvent<HTMLDivElement>): void {
    e.preventDefault();
    setDropping(false);
    choose(e.dataTransfer.files);
  }

  async function remove(): Promise<void> {
    if (removing || !window.confirm(CONFIRM_REMOVE)) return;
    setRemoving(true);
    setError(null);
    const res = await onRemove();
    setRemoving(false);
    if (res.ok) onRemoved(res.data);
    else setError({ message: `Couldn’t remove the recording: ${res.error.message}`, file: null });
  }

  const limitsLine = `mp3 or m4a · up to ${limits.maxAudioMb} MB / ${limits.maxAudioMinutes} min`;
  const pct = upload ? (upload.total > 0 ? Math.min(100, Math.round((upload.loaded / upload.total) * 100)) : 0) : 0;

  return (
    <div className="recording">
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_AUDIO}
        hidden
        onChange={(e) => {
          choose(e.target.files);
          e.target.value = '';
        }}
        data-testid="audio-file-input"
      />

      {upload ? (
        <div className="recording__progress" role="status" aria-live="polite">
          <progress className="recording__bar" max={100} value={pct} aria-label="Upload progress" />
          <p className="admin-hint">
            Uploading… {pct}% · {fmtMb(upload.loaded)} of {fmtMb(upload.total)}
          </p>
          <button type="button" className="admin-btn admin-btn--small" onClick={() => upload.controller.abort()}>
            Cancel
          </button>
        </div>
      ) : audio ? (
        <div className="recording__has">
          {/* Draft audio streams through /media/<key> (listen-audio: same route as readers). */}
          <audio
            ref={audioRef}
            className="recording__player"
            controls
            preload="metadata"
            src={audio.url}
            data-testid="listen-audio"
            onPlay={playerEvents?.onPlay}
            onPause={playerEvents?.onPause}
            onEnded={playerEvents?.onEnded}
            onSeeked={playerEvents?.onSeeked}
          >
            Your browser can’t play this recording here.
          </audio>
          <p className="recording__file mono">
            <span className="recording__name" title={audio.originalFilename}>
              {audio.originalFilename}
            </span>{' '}
            · {fmtMb(audio.bytes)} · {fmtClock(audio.durationMs)} · uploaded {relativeTime(audio.uploadedAt, now, timeZone)} by {audio.uploadedBy}
          </p>
          <div className="recording__actions">
            <button type="button" className="admin-btn admin-btn--small" ref={focusRef} disabled={disabled || removing} onClick={() => inputRef.current?.click()}>
              Replace…
            </button>
            <button type="button" className="admin-btn admin-btn--small admin-btn--ghost" disabled={disabled || removing} onClick={() => void remove()}>
              {removing ? 'Removing…' : 'Remove audio'}
            </button>
          </div>
          {props.children}
        </div>
      ) : (
        <div
          className={dropping ? 'dropzone is-dropping' : 'dropzone'}
          onDragOver={(e) => {
            e.preventDefault();
            if (!disabled) setDropping(true);
          }}
          onDragLeave={() => setDropping(false)}
          onDrop={onDrop}
        >
          <p className="dropzone__text">
            Drop an mp3 or m4a here, or{' '}
            <button type="button" className="linkbtn" ref={focusRef} disabled={disabled} onClick={() => inputRef.current?.click()}>
              choose a file
            </button>
          </p>
          <p className="admin-hint">{limitsLine}</p>
        </div>
      )}

      {error ? (
        <p className="admin-error" role="alert">
          {error.message}{' '}
          {error.file ? (
            <button type="button" className="linkbtn" onClick={() => void send(error.file as File)}>
              Try again
            </button>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
