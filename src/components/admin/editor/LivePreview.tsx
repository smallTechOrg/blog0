'use client';

import { useEffect, useRef, useState } from 'react';

import { ArticleBody } from '@/components/reader/ArticleBody';
import { ReadHead } from '@/components/reader/ReadHead';
import type { PreviewRequest, PreviewResultDto } from '@/lib/api/dto';

import { apiRequest } from '../api';

// Live Read preview (spec/architecture.md §3 Preview): 300 ms after typing stops, POST
// /api/admin/preview → render with the real ReadHead + ArticleBody inside `.readbody`, so the
// preview is the published page. The last render stays up while the next one loads (no
// flicker); an older response never overwrites a newer one (sequence + abort).

export const PREVIEW_DEBOUNCE_MS = 300;
export const PREVIEW_MAX_CHARS = 200_000;

export interface LivePreviewProps {
  title: string;
  dek: string;
  bodyMd: string;
  topic: string;
  bylineName: string;
  inProgress: boolean;
  dateLabel: string;
}

export function LivePreview({ title, dek, bodyMd, topic, bylineName, inProgress, dateLabel }: LivePreviewProps) {
  const [result, setResult] = useState<PreviewResultDto | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const seq = useRef(0);
  const first = useRef(true);
  const inflight = useRef<AbortController | null>(null);

  const empty = bodyMd.trim() === '';
  const tooLong = bodyMd.length > PREVIEW_MAX_CHARS;

  useEffect(() => {
    if (empty || tooLong) return;
    const mine = ++seq.current;
    const delay = first.current ? 0 : PREVIEW_DEBOUNCE_MS;
    first.current = false;
    const timer = window.setTimeout(async () => {
      inflight.current?.abort();
      const ac = new AbortController();
      inflight.current = ac;
      setPending(true);
      const body: PreviewRequest = { title, dek, bodyMd };
      const res = await apiRequest<PreviewResultDto>('/api/admin/preview', { method: 'POST', body, signal: ac.signal });
      if (mine !== seq.current) return; // a newer edit owns the preview now
      setPending(false);
      if (res.ok) {
        setResult(res.data);
        setError(null);
      } else if (res.error.code !== 'ABORTED') {
        setError(res.error.message);
      }
    }, delay);
    return () => window.clearTimeout(timer);
  }, [title, dek, bodyMd, empty, tooLong, retry]);

  useEffect(() => () => inflight.current?.abort(), []);

  return (
    <section className="preview" aria-label="Live preview">
      <div className="preview__bar">
        <span className="preview__label">Live preview</span>
        {result && !empty ? (
          <span className="preview__stats mono">
            {result.stats.words.toLocaleString('en-US')} words · {result.stats.readMinutes} min read ·{' '}
            {result.sentenceCount} eligible {result.sentenceCount === 1 ? 'sentence' : 'sentences'}
          </span>
        ) : null}
        <span className="preview__state" role="status" aria-live="polite">
          {pending && !empty ? 'Updating…' : ''}
        </span>
      </div>

      {error && !empty ? (
        <div className="admin-alert admin-alert--inline" role="alert">
          <p>Preview unavailable: {error}</p>
          <button type="button" className="admin-btn admin-btn--small" onClick={() => setRetry((n) => n + 1)}>
            Retry
          </button>
        </div>
      ) : null}
      {tooLong ? (
        <p className="admin-alert admin-alert--inline" role="alert">
          The Markdown is over {PREVIEW_MAX_CHARS.toLocaleString('en-US')} characters — trim it to preview and save.
        </p>
      ) : null}

      {result && !empty && result.warnings.length > 0 ? (
        <ul className="preview__warnings" aria-label="Preview warnings">
          {result.warnings.map((w, i) => (
            <li key={`${w.code}-${i}`}>
              <span className="mono">{w.code}</span> {w.message}
              {w.line ? <span className="admin-faint"> (line {w.line})</span> : null}
            </li>
          ))}
        </ul>
      ) : null}

      <div className={pending ? 'preview__doc is-updating' : 'preview__doc'}>
        <ReadHead
          title={title || 'Untitled'}
          dek={dek}
          topic={topic}
          bylineName={bylineName}
          dateLabel={dateLabel}
          inProgress={inProgress}
        />
        <div className="readbody">
          {empty ? (
            <p className="preview__empty">Start typing Markdown — the preview appears here.</p>
          ) : result ? (
            <ArticleBody blocks={result.blocks} />
          ) : (
            <p className="preview__empty">Rendering the preview…</p>
          )}
        </div>
      </div>
    </section>
  );
}
