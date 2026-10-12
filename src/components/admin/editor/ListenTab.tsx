'use client';

import { useEffect, useRef, useState } from 'react';

import type { AudioPlayerHandle } from '@/components/reader/AudioPlayer';
import type { ArticleDetailDto } from '@/lib/api/dto';
import type { ListenResponse, ListenStateDto, ListenStatus, ListenTiming } from '@/lib/api/dto';
import { fmtDate } from '@/lib/format-date';
import { listenMinutes } from '@/lib/listen/marks';

import { AudioUploader } from '../listen/AudioUploader';
import { deleteAudio, getListen } from '../listen/listen-api';
import { relativeTime } from '../relative-time';

// Listen tab (spec/ui.md §4 Listen tab, revised by the Phase 3 fix; capabilities listen-audio +
// listen-sync). Upload / replace / remove + a preview player + the estimated-timing note. There is
// no sync step: an upload is `ready` at once; editing paragraph text afterwards turns the status
// `text_changed` — a non-blocking warning. Loads GET …/listen when first shown and again after each
// saved revision (the status is computed against the current revision).

export interface ListenTabProps {
  article: ArticleDetailDto;
  /** The editor has unsaved text → uploading is disabled with the save-first hint. */
  editorDirty: boolean;
  timeZone: string;
  /** Re-reads the article (format chips, publish state) after an audio change. */
  onArticleChanged: () => void;
  /** The tab is showing. Hidden (but still mounted) → the preview player pauses. */
  active?: boolean;
}

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready' };
type Notice = { tone: 'ok' | 'error'; text: string } | null;

export const LISTEN_STATUS_LABEL: Record<ListenStatus, string> = {
  missing: 'No recording',
  ready: 'Ready',
  text_changed: 'Text changed',
};

export const TEXT_CHANGED_WARNING =
  'The recording may no longer match the text — paragraphs changed after it was uploaded. If the wording changed, upload a new reading. Publishing is not blocked.';

export const TIMING_NOTE: Record<ListenTiming, string> = {
  estimated:
    'Readers see the text follow along with estimated timing — from the recording’s length and each paragraph’s word count. Exact timing comes with automatic alignment later.',
  synced: 'Readers see the text follow along with the paragraph timings saved for this recording.',
};

/** One help line per status (spec/ui.md §4 Listen tab → Header). */
export function statusHelp(listen: ListenStateDto, now: Date, timeZone: string): string {
  switch (listen.status) {
    case 'missing':
      return `Upload a word-for-word reading (mp3 or m4a, up to ${listen.limits.maxAudioMb} MB / ${listen.limits.maxAudioMinutes} min). Readers get it on the next publish.`;
    case 'ready': {
      const a = listen.audio;
      const when = a ? ` · uploaded ${relativeTime(a.uploadedAt, now, timeZone)} by ${a.uploadedBy}` : '';
      return `Recording ready${when}. Readers get it on the next publish.`;
    }
    case 'text_changed':
      return 'The text changed after this recording was uploaded — see below.';
  }
}

/** "Live: N min recording, published <date>[ · differs from the draft]", or null with nothing published. */
export function liveLine(listen: Pick<ListenStateDto, 'published'>, timeZone: string): string | null {
  const p = listen.published;
  if (!p) return null;
  let date: string;
  try {
    date = fmtDate(p.publishedAt, timeZone);
  } catch {
    date = fmtDate(p.publishedAt, 'UTC');
  }
  return `Live: ${listenMinutes(p.durationMs)} min recording, published ${date}${p.sameAudioAsDraft ? '' : ' · differs from the draft'}`;
}

export function ListenTab(props: ListenTabProps) {
  const { article, editorDirty, timeZone, onArticleChanged, active = true } = props;
  const articleId = article.id;
  const revisionId = article.currentRevision.id;

  const [listen, setListen] = useState<ListenStateDto | null>(null);
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [reloadTick, setReloadTick] = useState(0);
  const [notice, setNotice] = useState<Notice>(null);
  const [now, setNow] = useState(() => new Date());
  const player = useRef<AudioPlayerHandle | null>(null);
  const uploaderFocus = useRef<HTMLButtonElement | null>(null);

  // (Re)load whenever the saved revision changes — the status is computed against it.
  useEffect(() => {
    let live = true;
    void getListen(articleId).then((res) => {
      if (!live) return;
      if (res.ok) {
        setListen(res.data);
        setNow(new Date());
        setLoad({ kind: 'ready' });
      } else {
        setLoad({ kind: 'error', message: res.error.message });
      }
    });
    return () => {
      live = false;
    };
  }, [articleId, revisionId, reloadTick]);

  // Hidden tab (still mounted): the preview stops playing.
  useEffect(() => {
    if (active) return;
    player.current?.audio()?.pause();
  }, [active]);

  function applyServer(state: ListenStateDto, text: string): void {
    setListen(state);
    setNow(new Date());
    setNotice({ tone: 'ok', text });
    onArticleChanged();
  }

  function onUploaded(res: ListenResponse): void {
    applyServer(res.listen, 'Recording uploaded — ready. Readers get it on the next publish.');
  }

  function onRemoved(res: ListenResponse): void {
    applyServer(res.listen, 'Recording removed.');
  }

  if (load.kind === 'loading' && !listen) {
    return (
      <p className="admin-muted" role="status">
        Loading the recording…
      </p>
    );
  }
  if (load.kind === 'error' && !listen) {
    return (
      <div className="admin-alert" role="alert">
        <p>Couldn’t load the recording: {load.message}</p>
        <button type="button" className="admin-btn" onClick={() => setReloadTick((n) => n + 1)}>
          Retry
        </button>
      </div>
    );
  }
  if (!listen) return null;

  const status = listen.status;
  const live = liveLine(listen, timeZone);

  return (
    <div className="listentab" data-status={status}>
      <div className="listentab__head">
        <div className="listentab__headl">
          <span className={`fchip fchip--${status}`} data-status={status} data-testid="listen-status">
            Listen · {LISTEN_STATUS_LABEL[status]}
          </span>
          <span className="admin-hint">{statusHelp(listen, now, timeZone)}</span>
        </div>
        {live ? (
          <span className="admin-hint listentab__live" data-testid="listen-live">
            {live}
          </span>
        ) : null}
      </div>

      {status === 'text_changed' ? (
        <div className="admin-alert is-warn listentab__warn" role="status" data-testid="listen-text-changed">
          <div className="listentab__warnbody">
            <p>{TEXT_CHANGED_WARNING}</p>
          </div>
          <div className="listentab__warnactions">
            <button type="button" className="admin-btn admin-btn--small" onClick={() => uploaderFocus.current?.focus()}>
              Upload a new recording
            </button>
          </div>
        </div>
      ) : null}

      {notice ? (
        <p className={notice.tone === 'ok' ? 'admin-ok' : 'admin-error'} role={notice.tone === 'ok' ? 'status' : 'alert'}>
          {notice.text}
        </p>
      ) : null}

      <section className="listentab__rec" aria-labelledby={`rec-h-${articleId}`}>
        <h2 className="tldrtab__h" id={`rec-h-${articleId}`}>
          Recording
        </h2>
        <AudioUploader
          articleId={articleId}
          audio={listen.audio}
          limits={listen.limits}
          bylineName={article.bylineName}
          playerRef={player}
          timeZone={timeZone}
          now={now}
          editorDirty={editorDirty}
          focusRef={uploaderFocus}
          onUploaded={onUploaded}
          onRemove={() => deleteAudio(articleId)}
          onRemoved={onRemoved}
        >
          {listen.timing ? (
            <p className="listentab__timing" data-testid="listen-timing" data-timing={listen.timing}>
              {TIMING_NOTE[listen.timing]}
            </p>
          ) : null}
        </AudioUploader>
      </section>
    </div>
  );
}
