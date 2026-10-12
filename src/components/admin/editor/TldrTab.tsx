'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  ArticleDetailDto,
  ClearDeckResponse,
  DeckInvalidDetails,
  GenerateTldrErrorDetails,
  GenerateTldrResponse,
  GenerationDto,
  SaveDeckResponse,
  SentenceDto,
  TldrStateDto,
} from '@/lib/api/dto';
import type { TldrStateDto as TldrStatePhase2 } from '@/lib/api/dto-phase2';

import { apiRequest } from '../api';
import { boundsHint, FORMAT_STATUS_LABEL, generationMeta } from '../labels';
import { DeckList } from '../tldr/DeckList';
import { DeckPreview } from '../tldr/DeckPreview';
import {
  addSentence,
  deckFromDraft,
  deckFromPicks,
  deckIsDirty,
  moveLine,
  reconcileDeck,
  removeLine,
  toSaveSlides,
  type DeckLine,
} from '../tldr/deck-edit';
import { SentencePicker } from '../tldr/SentencePicker';

import { generateButtonLabel, generatedNotice, runExclusive, type GeneratePhase } from './tldr-generate';

// TLDR tab (spec/ui.md §4, capability jev-tldr). Generate with Jev (one real call per click,
// "Save & generate" when the editor is dirty), meta/cost line, failure card with hand-pick
// fallback, hand-edit (remove / add from article lines / reorder), Preview deck (the real
// TldrDeck), Save deck, Reset to Jev's picks, Clear deck.

export interface TldrTabProps {
  article: ArticleDetailDto;
  editorDirty: boolean;
  title: string;
  dek: string;
  topic: string;
  dateLabel: string;
  timeZone: string;
  /** Saves the editor; resolves to the saved article, or null when the save failed. */
  saveFirst: () => Promise<ArticleDetailDto | null>;
  /** Re-reads the article (format chips, publish state) after a deck change. */
  onArticleChanged: () => void;
}

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready' };
type DeckState = { saved: DeckLine[]; lines: DeckLine[] };
type Failure = { message: string; generation: GenerationDto | null };
type Notice = { tone: 'ok' | 'error'; text: string } | null;

const NO_DECK: DeckState = { saved: [], lines: [] };

export const CONFIRM_REGENERATE = "Replace your current deck with Jev's new picks?";
export const CONFIRM_CLEAR = 'Clear the draft deck? The published deck (if any) keeps serving until you publish again.';

function trimStop(message: string): string {
  return message.replace(/[.\s]+$/, '');
}

export function TldrTab(props: TldrTabProps) {
  const { article, editorDirty, saveFirst, onArticleChanged, timeZone } = props;
  const articleId = article.id;
  const revisionId = article.currentRevision.id;

  const [tldr, setTldr] = useState<TldrStateDto | null>(null);
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [deck, setDeck] = useState<DeckState>(NO_DECK);
  const [running, setRunning] = useState<number | null>(null); // start time (ms)
  const [presaving, setPresaving] = useState(false); // "Save & generate": saving the editor first
  const generating = useRef(false); // set synchronously on click, so a double-click can't start twice
  const savingDeck = useRef(false); // same single-flight guard for Save deck
  const clearingDeck = useRef(false); // and for Clear deck
  const [elapsed, setElapsed] = useState(0);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState<null | 'save' | 'clear'>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [previewing, setPreviewing] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const [now, setNow] = useState(() => new Date());

  /** Take the server's state; keep the writer's unsaved deck edits unless `force`. */
  const applyServer = useCallback((state: TldrStateDto, force: boolean) => {
    setTldr(state);
    setNow(new Date());
    setDeck((prev) => {
      const fresh = deckFromDraft(state);
      if (force || !deckIsDirty(prev.saved, prev.lines)) return { saved: fresh, lines: fresh };
      return { saved: fresh, lines: reconcileDeck(prev.lines, state.sentences) };
    });
  }, []);

  // (Re)load whenever the saved revision changes — the sentence list belongs to it.
  useEffect(() => {
    let live = true;
    void apiRequest<TldrStateDto>(`/api/admin/articles/${articleId}/tldr`).then((res) => {
      if (!live) return;
      if (res.ok) {
        applyServer(res.data, false);
        setLoad({ kind: 'ready' });
      } else {
        setLoad({ kind: 'error', message: res.error.message });
      }
    });
    return () => {
      live = false;
    };
  }, [articleId, revisionId, reloadTick, applyServer]);

  // Elapsed seconds while Jev reads.
  useEffect(() => {
    if (running === null) return;
    const t = window.setInterval(() => setElapsed(Math.round((Date.now() - running) / 1000)), 500);
    return () => window.clearInterval(t);
  }, [running]);

  const sentences: SentenceDto[] = useMemo(() => tldr?.sentences ?? [], [tldr]);
  const chosen = useMemo(() => new Set(deck.lines.map((l) => l.sid)), [deck.lines]);
  const dirtyDeck = deckIsDirty(deck.saved, deck.lines);
  const missingCount = deck.lines.filter((l) => l.missing).length;
  const hasDraft = Boolean(tldr?.draft);
  const latest = tldr?.latestGeneration ?? null;
  const isRunning = running !== null;
  const inFlight = isRunning || presaving;
  const noSentences = !editorDirty && tldr !== null && sentences.length === 0;

  function generate(): Promise<void> {
    return runExclusive(generating, runGenerate).then(() => undefined);
  }

  async function runGenerate(): Promise<void> {
    if ((hasDraft || deck.lines.length > 0) && !window.confirm(CONFIRM_REGENERATE)) return;
    setNotice(null);
    setFailure(null);

    let revId = revisionId;
    if (editorDirty) {
      setPresaving(true);
      let saved: ArticleDetailDto | null;
      try {
        saved = await saveFirst();
      } finally {
        setPresaving(false);
      }
      if (!saved) {
        setNotice({ tone: 'error', text: 'Couldn’t save the article, so Jev didn’t run. Fix the save error above and try again.' });
        return;
      }
      revId = saved.currentRevision.id;
    }

    const started = Date.now();
    setElapsed(0);
    setRunning(started);
    const res = await apiRequest<GenerateTldrResponse>(`/api/admin/articles/${articleId}/tldr/generate`, {
      method: 'POST',
      body: { revisionId: revId },
    });
    setRunning(null);

    if (res.ok) {
      applyServer(res.data.tldr, true);
      setNotice({ tone: 'ok', text: generatedNotice(res.data.tldr.draft?.slides.length ?? 0) });
      onArticleChanged();
      return;
    }
    const details = res.error.details as Partial<GenerateTldrErrorDetails> | undefined;
    setFailure({ message: res.error.message, generation: details?.generation ?? null });
    onArticleChanged(); // chips: a failed run can move TLDR to `failed`
    // Refresh status + latest generation without touching the writer's deck.
    const fresh = await apiRequest<TldrStateDto>(`/api/admin/articles/${articleId}/tldr`);
    if (fresh.ok) applyServer(fresh.data, false);
  }

  function saveDeck(): Promise<void> {
    return runExclusive(savingDeck, runSaveDeck).then(() => undefined);
  }

  async function runSaveDeck(): Promise<void> {
    if (busy || deck.lines.length === 0) return;
    setBusy('save');
    setNotice(null);
    const res = await apiRequest<SaveDeckResponse>(`/api/admin/articles/${articleId}/tldr`, {
      method: 'PUT',
      body: { revisionId, slides: toSaveSlides(deck.lines) },
    });
    setBusy(null);
    if (res.ok) {
      applyServer(res.data.tldr, true);
      setNotice({ tone: 'ok', text: 'Deck saved.' });
      onArticleChanged();
      return;
    }
    if (res.error.code === 'DECK_INVALID') {
      const sids = (res.error.details as Partial<DeckInvalidDetails> | undefined)?.sids ?? [];
      setDeck((prev) => ({ ...prev, lines: prev.lines.map((l) => (sids.includes(l.sid) ? { ...l, missing: true } : l)) }));
    }
    if (res.error.code === 'CONFLICT') {
      setNotice({ tone: 'error', text: `${res.error.message} Reload the page to pick up the latest version.` });
      return;
    }
    setNotice({ tone: 'error', text: `Couldn’t save the deck: ${res.error.message}` });
  }

  function clearDeck(): Promise<void> {
    return runExclusive(clearingDeck, runClearDeck).then(() => undefined);
  }

  async function runClearDeck(): Promise<void> {
    if (busy || !window.confirm(CONFIRM_CLEAR)) return;
    setNotice(null);
    if (!hasDraft) {
      setDeck(NO_DECK);
      return;
    }
    setBusy('clear');
    const res = await apiRequest<ClearDeckResponse>(`/api/admin/articles/${articleId}/tldr`, { method: 'DELETE' });
    setBusy(null);
    if (res.ok) {
      applyServer(res.data.tldr, true);
      setNotice({ tone: 'ok', text: 'Draft deck cleared.' });
      onArticleChanged();
    } else {
      setNotice({ tone: 'error', text: `Couldn’t clear the deck: ${res.error.message}` });
    }
  }

  function resetToJev(): void {
    if (!latest?.picks) return;
    const { lines, dropped } = deckFromPicks(latest.picks, sentences);
    setDeck((prev) => ({ ...prev, lines }));
    setNotice(
      dropped > 0
        ? { tone: 'error', text: `${dropped} of Jev’s picks are no longer in the article and were left out.` }
        : { tone: 'ok', text: 'Deck reset to Jev’s picks — Save deck to keep it.' },
    );
  }

  function toggle(sentence: SentenceDto, checked: boolean): void {
    setDeck((prev) => ({
      ...prev,
      lines: checked ? addSentence(prev.lines, sentence, sentences) : removeLine(prev.lines, sentence.sid),
    }));
  }

  if (load.kind === 'loading' && !tldr) {
    return (
      <p className="admin-muted" role="status">
        Loading the TLDR deck…
      </p>
    );
  }
  if (load.kind === 'error' && !tldr) {
    return (
      <div className="admin-alert" role="alert">
        <p>Couldn’t load the TLDR deck: {load.message}</p>
        <button type="button" className="admin-btn" onClick={() => setReloadTick((n) => n + 1)}>
          Retry
        </button>
      </div>
    );
  }

  const status = tldr?.status ?? 'missing';
  const phase: GeneratePhase = isRunning ? 'running' : presaving ? 'saving' : 'idle';
  const generateLabel = generateButtonLabel({
    phase,
    elapsed,
    editorDirty,
    hasDraft,
    latestSucceeded: latest?.status === 'succeeded',
  });
  const saveDisabled = busy !== null || inFlight || !dirtyDeck || deck.lines.length === 0 || missingCount > 0;
  const saveHint =
    deck.lines.length === 0 && hasDraft
      ? 'A deck needs at least one line — use Clear deck to remove it.'
      : missingCount > 0
        ? 'Remove the lines that are no longer in the article before saving.'
        : null;
  const readMinutes = Math.max(1, Math.ceil(article.currentRevision.wordCount / 230));
  // Designer mode with no OpenRouter key (spec/ui.md §4, Phase 2): Generate disabled + notice.
  const jevAvailable = (tldr as TldrStatePhase2 | null)?.jevAvailable !== false;

  return (
    <div className="tldrtab">
      <div className="tldrtab__head">
        <div className="tldrtab__headl">
          <span className={`fchip fchip--${status}`} data-status={status}>
            TLDR {FORMAT_STATUS_LABEL[status] ?? status}
          </span>
          <span className="admin-hint">{boundsHint(tldr?.bounds ?? null)}</span>
        </div>
        <button
          type="button"
          className="admin-btn admin-btn--primary"
          onClick={() => void generate()}
          disabled={inFlight || busy !== null || noSentences || !jevAvailable}
          aria-busy={inFlight}
          title={
            !jevAvailable ? 'No OpenRouter key configured' : noSentences ? 'The saved article has no eligible sentences' : undefined
          }
        >
          {inFlight ? <span className="spinner" aria-hidden="true" /> : null}
          {generateLabel}
        </button>
      </div>

      {!jevAvailable ? (
        <p className="stub" role="note" data-testid="jev-no-key">
          <span className="stub__label">No OpenRouter key configured</span> — add <code>BLOG0_OPENROUTER_API_KEY</code> to{' '}
          <code>.env</code> to generate with Jev. You can still pick lines yourself from the article on the right.
        </p>
      ) : null}
      {latest && latest.status === 'succeeded' && !failure ? (
        <p className="tldrtab__meta mono">{generationMeta(latest, now, timeZone)}</p>
      ) : null}
      {status === 'stale' ? (
        <p className="tldrtab__stale">
          The text changed since this deck was saved. Fix flagged lines or regenerate (one AI call) — the live page keeps its
          published deck until you publish.
        </p>
      ) : null}
      {editorDirty ? (
        <p className="admin-hint">
          The lines below come from the last save (rev {article.currentRevision.number}). Save to pick from your latest text.
        </p>
      ) : null}

      {failure || (latest?.status === 'failed' && !isRunning) ? (
        <div className="failcard" role="alert">
          <p>
            Jev couldn’t make a deck: {trimStop(failure?.message ?? latest?.errorMessage ?? 'unknown error')}.
          </p>
          <p>
            <button
              type="button"
              className="admin-btn admin-btn--small"
              onClick={() => void generate()}
              disabled={inFlight || noSentences || !jevAvailable}
            >
              Try again
            </button>{' '}
            <span className="admin-muted">or pick lines yourself from the article on the right.</span>
          </p>
        </div>
      ) : null}

      {notice ? (
        <p className={notice.tone === 'ok' ? 'admin-ok' : 'admin-error'} role={notice.tone === 'ok' ? 'status' : 'alert'}>
          {notice.text}
        </p>
      ) : null}

      <div className={isRunning ? 'tldrtab__cols is-dim' : 'tldrtab__cols'} aria-busy={isRunning}>
        <section className="tldrtab__col" aria-labelledby={`deck-h-${articleId}`}>
          <h2 className="tldrtab__h" id={`deck-h-${articleId}`}>
            Deck <span className="admin-faint">({deck.lines.length})</span>
            {dirtyDeck ? <span className="dirtydot" title="Unsaved deck changes" aria-label="unsaved changes" /> : null}
          </h2>
          {deck.lines.length === 0 ? (
            <p className="tldrtab__empty">
              No deck yet. Jev reads the saved article and picks 4–8 lines, word for word. One call, usually under a cent.
            </p>
          ) : (
            <DeckList
              lines={deck.lines}
              disabled={inFlight || busy !== null}
              onMove={(pos, delta) => setDeck((prev) => ({ ...prev, lines: moveLine(prev.lines, pos, delta) }))}
              onRemove={(sid) => setDeck((prev) => ({ ...prev, lines: removeLine(prev.lines, sid) }))}
            />
          )}
        </section>
        <section className="tldrtab__col" aria-labelledby={`lines-h-${articleId}`}>
          <h2 className="tldrtab__h" id={`lines-h-${articleId}`}>
            Article lines <span className="admin-faint">({sentences.length})</span>
          </h2>
          <SentencePicker
            sentences={sentences}
            chosen={chosen}
            deckSize={deck.lines.length}
            onToggle={toggle}
            disabled={inFlight || busy !== null}
          />
        </section>
      </div>

      <div className="tldrtab__foot">
        <button type="button" className="admin-btn admin-btn--primary" onClick={() => void saveDeck()} disabled={saveDisabled}>
          {busy === 'save' ? 'Saving deck…' : 'Save deck'}
          {dirtyDeck && busy !== 'save' ? <span className="dirtydot" aria-hidden="true" /> : null}
        </button>
        <button
          type="button"
          className="admin-btn"
          onClick={() => setPreviewing(true)}
          disabled={deck.lines.length === 0 || inFlight}
        >
          Preview deck
        </button>
        {latest?.status === 'succeeded' && latest.picks && latest.picks.length > 0 ? (
          <button type="button" className="admin-btn admin-btn--ghost" onClick={resetToJev} disabled={inFlight || busy !== null}>
            Reset to Jev’s picks
          </button>
        ) : null}
        {deck.lines.length > 0 || hasDraft ? (
          <button type="button" className="admin-btn admin-btn--ghost" onClick={() => void clearDeck()} disabled={inFlight || busy !== null}>
            {busy === 'clear' ? 'Clearing…' : 'Clear deck'}
          </button>
        ) : null}
        {saveHint ? <span className="admin-hint">{saveHint}</span> : null}
      </div>

      {previewing ? (
        <DeckPreview
          title={props.title || 'Untitled'}
          dek={props.dek}
          topic={props.topic}
          dateLabel={props.dateLabel}
          readMinutes={readMinutes}
          lines={deck.lines}
          shareLink={article.publicUrl ? `${article.publicUrl.replace(/\/$/, '')}/tldr` : undefined}
          onClose={() => setPreviewing(false)}
        />
      ) : null}
    </div>
  );
}
