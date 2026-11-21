'use client';

import type { AssistantCommentKind } from '@/lib/api/dto';

import { relativeTime } from '../relative-time';
import { SENTENCE_MIN_WORDS, WORDS_THRESHOLD } from './assistant-trigger';
import type { AssistantStatus, WritingAssistant } from './use-writing-assistant';

// The writing assistant's side panel (SMA-43; spec/ui.md §4 "Write tab"): on/off, what it is doing,
// "Review now", and the latest comments (plus two earlier rounds, collapsed). It only comments —
// accuracy, what is missing, what is unclear — and never edits the draft.

export const KIND_LABEL: Record<AssistantCommentKind, string> = {
  accuracy: 'Accuracy',
  missing: 'Add',
  clarity: 'Clarity',
  question: 'Question',
  note: 'Note',
};

export function statusText(s: AssistantStatus): string {
  switch (s.kind) {
    case 'checking':
      return 'Checking the AI provider…';
    case 'unconfigured':
      return 'Set up an AI provider to use the assistant.';
    case 'off':
      return 'Off — turn it on to get comments while you write.';
    case 'reading':
      return s.trigger === 'sentence' ? 'Reading your new sentence…' : 'Reading your draft…';
    case 'error':
      return `Couldn’t read the draft: ${s.message}`;
    case 'watching':
      return `Watching — it reads again after a finished sentence (${SENTENCE_MIN_WORDS}+ words) or about ${WORDS_THRESHOLD} changed words.`;
  }
}

export function AssistantPanel({ assistant, timeZone, now = new Date() }: { assistant: WritingAssistant; timeZone: string; now?: Date }) {
  const { status, rounds, on, setOn, reviewNow } = assistant;
  const [latest, ...earlier] = rounds;
  const usable = status.kind !== 'unconfigured' && status.kind !== 'checking';
  return (
    <aside className="assist" aria-labelledby="assist-h">
      <div className="assist__head">
        <h2 className="assist__title" id="assist-h">
          Assistant
        </h2>
        <label className="admin-check assist__toggle">
          <input type="checkbox" checked={on} disabled={!usable} onChange={(e) => setOn(e.target.checked)} />
          On
        </label>
      </div>
      <p className={`assist__status assist__status--${status.kind}`} role={status.kind === 'error' ? 'alert' : 'status'} data-testid="assist-status">
        {statusText(status)}
        {status.kind === 'unconfigured' ? (
          <>
            {' '}
            <a href="/admin/site#ai">Site → AI provider</a>
          </>
        ) : null}
      </p>
      {usable && on ? (
        <p className="assist__actions">
          <button type="button" className="admin-btn admin-btn--small" onClick={reviewNow} disabled={status.kind === 'reading'}>
            Review now
          </button>
          <span className="admin-hint">Comments only — it never changes your text.</span>
        </p>
      ) : null}
      {latest ? (
        <>
          <p className="admin-hint assist__when">Read {relativeTime(new Date(latest.at).toISOString(), now, timeZone)}</p>
          <CommentList comments={latest.comments} testId="assist-comments" />
        </>
      ) : usable && on ? (
        <p className="admin-muted assist__empty">No comments yet. Keep writing.</p>
      ) : null}
      {earlier.length > 0 ? (
        <details className="assist__earlier">
          <summary>Earlier ({earlier.reduce((n, r) => n + r.comments.length, 0)})</summary>
          {earlier.map((r) => (
            <CommentList key={r.at} comments={r.comments} />
          ))}
        </details>
      ) : null}
    </aside>
  );
}

function CommentList({ comments, testId }: { comments: WritingAssistant['rounds'][number]['comments']; testId?: string }) {
  if (comments.length === 0) return <p className="admin-muted assist__empty" data-testid={testId}>Nothing to flag in that stretch.</p>;
  return (
    <ul className="assist__list" data-testid={testId}>
      {comments.map((c, i) => (
        <li key={i} className={`assist__item assist__item--${c.kind}`}>
          <span className="assist__kind">{KIND_LABEL[c.kind]}</span>
          {c.quote ? <q className="assist__quote">{c.quote}</q> : null}
          <p className="assist__text">{c.text}</p>
        </li>
      ))}
    </ul>
  );
}
