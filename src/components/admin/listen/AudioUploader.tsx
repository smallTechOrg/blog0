'use client';

import { useRef, useState, type DragEvent, type ReactNode, type RefObject } from 'react';

import { AudioPlayer, type AudioPlayerHandle } from '@/components/reader/AudioPlayer';
import type { ListenAudioDto, ListenResponse } from '@/lib/api/dto';
import { fmtClock } from '@/lib/listen/marks';

import type { ApiResult } from '../api';
import { relativeTime } from '../relative-time';

import { fmtMb, uploadAudio } from './listen-api';

// Recording section of the Listen tab (spec/ui.md §4 Listen tab → Recording; Phase 3 fix): dropzone
// + file picker (disabled while the editor has unsaved text), XHR progress with Cancel, inline
// errors with Try again, and — once a recording exists — the design `.audio` player as the
// preview, the file line, Replace… (no confirm: there is no writer-made sync to lose) and Remove
// audio (confirmed).

export const ACCEPT_AUDIO = 'audio/mpeg,audio/mp4,.mp3,.m4a';

export const UNSAVED_TEXT_HINT = 'Save your text changes first — the recording is matched against the saved article.';
export const CONFIRM_REMOVE = 'Remove the recording? The published Listen keeps serving until you publish again.';

export interface AudioUploaderProps {
  articleId: string;
  audio: ListenAudioDto | null;
  limits: { maxAudioMb: number; maxAudioMinutes: number };
  /** The preview player's byline ("Read by <name> · N min"). */
  bylineName: string;
  /** The preview player (the tab pauses it when hidden). */
  playerRef?: RefObject<AudioPlayerHandle | null>;
  /** Under the player (the tab's timing note). */
  children?: ReactNode;
  timeZone: string;
  /** Reference time for "uploaded <relative time>" (the tab refreshes it with each server state). */
  now: Date;
  /** The editor has unsaved text: uploading is disabled with the save-first hint. */
  editorDirty: boolean;
  /** Focus the dropzone's picker / Replace… (the text-changed warning's "Upload a new recording"). */
  focusRef?: RefObject<HTMLButtonElement | null>;
  onUploaded: (res: ListenResponse) => void;
  onRemove: () => Promise<ApiResult<ListenResponse>>;
  onRemoved: (res: ListenResponse) => void;
}

type Upload = { file: File; loaded: number; total: number; controller: AbortController };

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
  const { articleId, audio, limits, bylineName, playerRef, timeZone, now, editorDirty, focusRef, onUploaded, onRemove, onRemoved } = props;
  const inputRef = useRef<HTMLInputElement>(null);
  const [upload, setUpload] = useState<Upload | null>(null);
  const [error, setError] = useState<{ message: string; file: File | null } | null>(null);
  const [dropping, setDropping] = useState(false);
  const [removing, setRemoving] = useState(false);
  const inFlight = useRef(false);
  const locked = editorDirty;

  async function send(file: File): Promise<void> {
    if (inFlight.current || locked) return;
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
    if (!file || locked || upload) return;
    if (!looksLikeAudio(file)) {
      setError({ message: `“${file.name}” doesn’t look like an mp3 or m4a. Choose a recording in one of those formats.`, file: null });
      return;
    }
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
  const lockedHint = locked ? (
    <p className="admin-hint recording__locked" data-testid="upload-locked">
      {UNSAVED_TEXT_HINT}
    </p>
  ) : null;

  return (
    <div className="recording">
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_AUDIO}
        hidden
        disabled={locked}
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
        <div className="recording__has" data-testid="listen-preview">
          {/* Draft audio streams through /media/<key> (listen-audio: same route and player as readers). */}
          <AudioPlayer
            key={audio.assetId}
            ref={playerRef}
            audio={{ url: audio.url, mimeType: audio.mimeType, durationMs: audio.durationMs }}
            bylineName={bylineName}
          />
          {props.children}
          <p className="recording__file mono">
            <span className="recording__name" title={audio.originalFilename}>
              {audio.originalFilename}
            </span>{' '}
            · {fmtMb(audio.bytes)} · {fmtClock(audio.durationMs)} · uploaded {relativeTime(audio.uploadedAt, now, timeZone)} by {audio.uploadedBy}
          </p>
          <div className="recording__actions">
            <button type="button" className="admin-btn admin-btn--small" ref={focusRef} disabled={locked || removing} onClick={() => inputRef.current?.click()}>
              Replace…
            </button>
            <button type="button" className="admin-btn admin-btn--small admin-btn--ghost" disabled={removing} onClick={() => void remove()}>
              {removing ? 'Removing…' : 'Remove audio'}
            </button>
          </div>
          {lockedHint}
        </div>
      ) : (
        <div
          className={dropping ? 'dropzone is-dropping' : 'dropzone'}
          aria-disabled={locked ? 'true' : undefined}
          onDragOver={(e) => {
            e.preventDefault();
            if (!locked) setDropping(true);
          }}
          onDragLeave={() => setDropping(false)}
          onDrop={onDrop}
        >
          <p className="dropzone__text">
            Drop an mp3 or m4a here, or{' '}
            <button type="button" className="linkbtn" ref={focusRef} disabled={locked} onClick={() => inputRef.current?.click()}>
              choose a file
            </button>
          </p>
          <p className="admin-hint">{limitsLine}</p>
          {lockedHint}
        </div>
      )}

      {error ? (
        <p className="admin-error" role="alert">
          {error.message}{' '}
          {error.file && !locked ? (
            <button type="button" className="linkbtn" onClick={() => void send(error.file as File)}>
              Try again
            </button>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
