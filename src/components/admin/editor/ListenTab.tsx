'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { ArticleDetailDto } from '@/lib/api/dto';
import type { ListenResponse, ListenStateDto, ListenStatus, MarkIssueCode, MarksInvalidDetails } from '@/lib/api/dto-phase3';
import { MARKS_INVALID } from '@/lib/api/dto-phase3';
import { fmtDate } from '@/lib/format-date';
import { activeMarkIndex, listenMinutes, validateMarks } from '@/lib/listen/marks';

import { AudioUploader } from '../listen/AudioUploader';
import { deleteAudio, getListen, saveListen } from '../listen/listen-api';
import { MarkList } from '../listen/MarkList';
import { SyncPanel } from '../listen/SyncPanel';
import { marksOf, unmarkedCount, useTapSync } from '../listen/useTapSync';
import { relativeTime } from '../relative-time';

import { runExclusive } from './tldr-generate';

// Listen tab (spec/ui.md §4 Listen tab; capabilities listen-audio + listen-sync). Loads
// GET …/listen when first shown; Recording column (upload / player / replace / remove) and the
// Paragraphs column (sync controls + mark list); Save sync validates client-side with
// validateMarks before the PUT; unsaved marks are reported to the editor for its leave guards.

export interface ListenTabProps {
  article: ArticleDetailDto;
  editorDirty: boolean;
  timeZone: string;
  /** Saves the editor's text (the "Save now" offer when syncing is blocked by unsaved text). */
  saveFirst: () => Promise<ArticleDetailDto | null>;
  /** Re-reads the article (format chips, publish state) after an audio / sync change. */
  onArticleChanged: () => void;
  onSelectTab: (tab: 'write' | 'tldr' | 'listen' | 'history') => void;
  /** Unsaved marks exist → the editor guards tab switches and page leave. */
  onMarksDirty: (dirty: boolean) => void;
}

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready' };
type Notice = { tone: 'ok' | 'error'; text: string } | null;

export const LISTEN_STATUS_LABEL: Record<ListenStatus, string> = {
  missing: 'No recording',
  needs_sync: 'Needs sync',
  ready: 'Synced',
  stale: 'Text changed — re-sync',
};

export function statusHelp(listen: ListenStateDto, now: Date, timeZone: string): string {
  switch (listen.status) {
    case 'missing':
      return `Upload a word-for-word reading (mp3 or m4a, up to ${listen.limits.maxAudioMb} MB / ${listen.limits.maxAudioMinutes} min), then tap along to sync it.`;
    case 'needs_sync':
      return 'Recording uploaded. Press Start syncing and tap at the start of each paragraph.';
    case 'ready':
      return `Synced ${listen.marks.length} ${listen.marks.length === 1 ? 'paragraph' : 'paragraphs'}${
        listen.syncedAt ? ` · ${relativeTime(listen.syncedAt, now, timeZone)}` : ''
      }${listen.syncedBy ? ` by ${listen.syncedBy}` : ''}`;
    case 'stale':
      return 'The text changed since this recording was synced — see below.';
  }
}

const NO_MARKS: ListenStateDto['marks'] = [];

function listenKey(l: ListenStateDto): string {
  return `${l.revisionId}:${l.audio?.assetId ?? '-'}:${l.syncedAt ?? '-'}`;
}

export function ListenTab(props: ListenTabProps) {
  const { article, editorDirty, timeZone, saveFirst, onArticleChanged, onSelectTab, onMarksDirty } = props;
  const articleId = article.id;
  const revisionId = article.currentRevision.id;

  const [listen, setListen] = useState<ListenStateDto | null>(null);
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [reloadTick, setReloadTick] = useState(0);
  const [notice, setNotice] = useState<Notice>(null);
  const [issues, setIssues] = useState<ReadonlyMap<string, MarkIssueCode[]>>(() => new Map());
  const [busy, setBusy] = useState<null | 'save'>(null);
  const [presaving, setPresaving] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const saving = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const uploaderFocus = useRef<HTMLButtonElement | null>(null);

  const paragraphs = useMemo(() => listen?.paragraphs ?? [], [listen]);
  const pids = useMemo(() => paragraphs.map((p) => p.pid), [paragraphs]);
  const durationMs = listen?.audio?.durationMs ?? 0;
  const serverMarks = listen?.marks ?? NO_MARKS;

  const tap = useTapSync({ pids, durationMs, serverMarks, audioRef });
  const { load: loadMarks, state: tapState, dirty } = tap;
  const tapRef = useRef(tap);
  useLayoutEffect(() => {
    tapRef.current = tap;
  });

  // (Re)load whenever the saved revision changes — the paragraph list belongs to it.
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

  // Which server state the working marks were last aligned with, and the paragraph ids they map to.
  const loadedFor = useRef<string | null>(null);
  const alignedPids = useRef<readonly string[]>([]);

  // Align the working marks with a server state: keep the writer's unsaved marks (re-keyed by
  // pid) unless `force` or nothing is unsaved.
  const align = useCallback(
    (state: ListenStateDto, force: boolean) => {
      const current = tapRef.current;
      const nextPids = state.paragraphs.map((p) => p.pid);
      const keep = !force && loadedFor.current !== null && current.dirty;
      loadMarks(keep ? marksOf(current.state, alignedPids.current) : state.marks, nextPids);
      loadedFor.current = listenKey(state);
      alignedPids.current = nextPids;
    },
    [loadMarks],
  );

  const applyServer = useCallback(
    (state: ListenStateDto, force: boolean) => {
      setListen(state);
      setNow(new Date());
      setIssues(new Map());
      align(state, force);
    },
    [align],
  );

  // First load / revision reload (GET …/listen): align unless already aligned with this state.
  useEffect(() => {
    if (listen && loadedFor.current !== listenKey(listen)) align(listen, false);
  }, [listen, align]);

  useEffect(() => {
    onMarksDirty(dirty);
  }, [dirty, onMarksDirty]);
  useEffect(() => () => onMarksDirty(false), [onMarksDirty]);

  // Player clock: rAF while playing, snap on seek.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = -1;
    const tick = () => {
      const el = audioRef.current;
      if (el) {
        const ms = Math.floor(el.currentTime * 1000);
        if (ms !== last) {
          last = ms;
          setCurrentMs(ms);
        }
      }
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [playing]);

  const playerEvents = useMemo(
    () => ({
      onPlay: () => setPlaying(true),
      onPause: () => {
        setPlaying(false);
        const el = audioRef.current;
        if (el) setCurrentMs(Math.floor(el.currentTime * 1000));
      },
      onEnded: () => {
        setPlaying(false);
        tapRef.current.ended();
      },
      onSeeked: () => {
        const el = audioRef.current;
        if (el) setCurrentMs(Math.floor(el.currentTime * 1000));
      },
    }),
    [],
  );

  const workingMarks = useMemo(() => marksOf(tapState, pids), [tapState, pids]);
  const validation = useMemo(() => validateMarks(workingMarks, pids, durationMs), [workingMarks, pids, durationMs]);
  const unmarked = unmarkedCount(tapState);

  // Preview playback: the row the player is in (idle only — while syncing .is-next leads).
  const liveIndex = useMemo(() => {
    if (!playing || tapState.phase === 'syncing') return -1;
    const k = activeMarkIndex(workingMarks, currentMs);
    if (k < 0) return -1;
    return pids.indexOf(workingMarks[k].pid);
  }, [playing, tapState.phase, workingMarks, currentMs, pids]);

  function save(): Promise<void> {
    return runExclusive(saving, runSave).then(() => undefined);
  }

  async function runSave(): Promise<void> {
    if (!listen || !listen.audio || busy || !validation.ok) return;
    setBusy('save');
    setNotice(null);
    setIssues(new Map());
    const res = await saveListen(articleId, { revisionId, marks: workingMarks });
    setBusy(null);
    if (res.ok) {
      applyServer(res.data.listen, true);
      setNotice({ tone: 'ok', text: `Sync saved — ${res.data.listen.marks.length} paragraphs marked.` });
      onArticleChanged();
      return;
    }
    if (res.error.code === MARKS_INVALID) {
      const reasons = (res.error.details as Partial<MarksInvalidDetails> | undefined)?.reasons ?? [];
      const map = new Map<string, MarkIssueCode[]>();
      for (const r of reasons) {
        const pid = r.pid ?? (r.index !== undefined ? workingMarks[r.index]?.pid : undefined);
        if (!pid) continue;
        map.set(pid, [...(map.get(pid) ?? []), r.code]);
      }
      setIssues(map);
      setNotice({ tone: 'error', text: `Couldn’t save the sync: ${res.error.message}` });
      return;
    }
    if (res.error.code === 'CONFLICT') {
      setNotice({ tone: 'error', text: `${res.error.message} Reload the page to pick up the latest version.` });
      return;
    }
    setNotice({ tone: 'error', text: `Couldn’t save the sync: ${res.error.message}` });
  }

  function discard(): void {
    tap.discard();
    setIssues(new Map());
    setNotice(null);
  }

  function onUploaded(res: ListenResponse): void {
    applyServer(res.listen, true);
    setCurrentMs(0);
    setPlaying(false);
    setNotice({ tone: 'ok', text: 'Recording uploaded. Press Start syncing and tap at the start of each paragraph.' });
    onArticleChanged();
  }

  function onRemoved(res: ListenResponse): void {
    applyServer(res.listen, true);
    setCurrentMs(0);
    setPlaying(false);
    setNotice({ tone: 'ok', text: 'Recording removed.' });
    onArticleChanged();
  }

  function preview(index: number): void {
    const t = tapState.times[index];
    const el = audioRef.current;
    if (t === null || t === undefined || !el) return;
    el.currentTime = t / 1000;
    void el.play()?.catch(() => undefined);
  }

  async function saveTextNow(): Promise<void> {
    setPresaving(true);
    try {
      await saveFirst();
    } finally {
      setPresaving(false);
    }
  }

  function resyncFromFirstChange(): void {
    if (!listen) return;
    const first = listen.missingPids.length ? pids.indexOf(listen.missingPids[0]) : -1;
    tap.redoFrom(first >= 0 ? first : 0);
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
  const syncing = tapState.phase === 'syncing';
  const missingSet = new Set(listen.missingPids);
  const saveDisabled = busy !== null || syncing || !dirty || !validation.ok || !listen.audio;
  const saveSummary = !listen.audio
    ? null
    : unmarked > 0
      ? `${unmarked} ${unmarked === 1 ? 'paragraph still needs' : 'paragraphs still need'} a mark`
      : !validation.ok
        ? 'Some marks are out of order — nudge or redo them'
        : !dirty
          ? 'Marks are saved'
          : null;
  const publishedDiffers =
    listen.published && (!listen.published.matchesCurrentText || (listen.audio ? listen.audio.durationMs !== listen.published.durationMs : true));
  let publishedDate = '';
  if (listen.published) {
    try {
      publishedDate = fmtDate(listen.published.publishedAt, timeZone);
    } catch {
      publishedDate = fmtDate(listen.published.publishedAt, 'UTC');
    }
  }

  return (
    <div className="listentab" data-status={status} data-phase={tapState.phase}>
      <div className="listentab__head">
        <div className="listentab__headl">
          <span className={`fchip fchip--${status}`} data-status={status} data-testid="listen-status">
            Listen · {LISTEN_STATUS_LABEL[status]}
          </span>
          <span className="admin-hint">{statusHelp(listen, now, timeZone)}</span>
        </div>
        {listen.published ? (
          <span className="admin-hint listentab__live">
            Live: {listenMinutes(listen.published.durationMs)} min recording, published {publishedDate}
            {publishedDiffers ? ' · differs from the draft' : ''}
          </span>
        ) : null}
      </div>

      {status === 'stale' ? (
        <div className="admin-alert is-warn listentab__stale" role="alert">
          <div className="listentab__stalebody">
            <p>
              The text changed since this recording was synced. {listen.missingPids.length}{' '}
              {listen.missingPids.length === 1 ? 'paragraph is' : 'paragraphs are'} new or edited and {listen.missingPids.length === 1 ? 'has' : 'have'} no mark;{' '}
              {listen.orphanPids.length} {listen.orphanPids.length === 1 ? 'mark belongs' : 'marks belong'} to paragraphs that were removed.
            </p>
            <p className="listentab__stalewarn">
              If the words changed, the recording no longer matches — upload a new reading. Publishing is blocked until Listen is synced or the
              audio is removed.
            </p>
          </div>
          <div className="listentab__staleactions">
            <button type="button" className="admin-btn admin-btn--small admin-btn--primary" disabled={editorDirty || !listen.audio} onClick={resyncFromFirstChange}>
              Re-sync from the first change
            </button>
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

      <div className="listentab__cols">
        <section className="listentab__col listentab__col--rec" aria-labelledby={`rec-h-${articleId}`}>
          <h2 className="tldrtab__h" id={`rec-h-${articleId}`}>
            Recording
          </h2>
          <AudioUploader
            articleId={articleId}
            audio={listen.audio}
            limits={listen.limits}
            markCount={workingMarks.length}
            audioRef={audioRef}
            timeZone={timeZone}
            now={now}
            disabled={syncing || busy !== null}
            focusRef={uploaderFocus}
            playerEvents={playerEvents}
            onUploaded={onUploaded}
            onRemove={() => deleteAudio(articleId)}
            onRemoved={onRemoved}
          />
        </section>

        <section className="listentab__col listentab__col--paras" aria-labelledby={`paras-h-${articleId}`}>
          <h2 className="tldrtab__h" id={`paras-h-${articleId}`}>
            Paragraphs <span className="admin-faint">({paragraphs.length})</span>
            {dirty ? <span className="dirtydot" title="Unsaved marks" aria-label="unsaved marks" /> : null}
          </h2>
          {editorDirty && !syncing ? (
            <p className="admin-hint">
              The paragraphs below come from the last save (rev {article.currentRevision.number}).{' '}
              <button type="button" className="linkbtn" disabled={presaving} onClick={() => void saveTextNow()}>
                {presaving ? 'Saving…' : 'Save now'}
              </button>
            </p>
          ) : null}
          <SyncPanel
            state={tapState}
            paragraphCount={paragraphs.length}
            currentMs={currentMs}
            hasAudio={Boolean(listen.audio)}
            editorDirty={editorDirty}
            busy={busy !== null}
            onStart={tap.start}
            onTap={tap.tap}
            onUndo={tap.undo}
            onRestart={tap.restart}
            onStop={tap.stop}
            onGoToWrite={() => onSelectTab('write')}
          />
          <MarkList
            paragraphs={paragraphs}
            state={tapState}
            durationMs={durationMs}
            missingPids={missingSet}
            liveIndex={liveIndex}
            issues={issues}
            disabled={busy !== null || !listen.audio || editorDirty}
            onNudge={tap.nudge}
            onRedoFrom={tap.redoFrom}
            onPreview={preview}
          />
        </section>
      </div>

      <div className="tldrtab__foot listentab__foot">
        <button type="button" className="admin-btn admin-btn--primary" onClick={() => void save()} disabled={saveDisabled} data-testid="save-sync">
          {busy === 'save' ? 'Saving…' : 'Save sync'}
          {dirty && busy !== 'save' ? <span className="dirtydot" aria-hidden="true" /> : null}
        </button>
        <button type="button" className="admin-btn admin-btn--ghost" onClick={discard} disabled={!dirty || busy !== null}>
          Discard changes
        </button>
        {saveSummary && saveDisabled ? (
          <span className="admin-hint" data-testid="save-summary">
            {saveSummary}
          </span>
        ) : null}
      </div>
    </div>
  );
}
