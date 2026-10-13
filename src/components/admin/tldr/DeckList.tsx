'use client';

import { relevanceLabel } from '../labels';

import type { DeckLine } from './deck-edit';

// The ordered draft deck (spec/ui.md §4 TLDR tab → Deck): ordinal, verbatim line, meta line
// ("Jev · relevance 0.82" / "Added by you · relevance 0.41"; the score is left out when null),
// ↑ ↓ ✕; lines that vanished from the text are flagged. No reasons anywhere (Phase 8).

/** "relevance 0.82" in its muted monospace span; nothing when the score is null. */
export function RelevanceTag({ relevance }: { relevance: number | null }) {
  const label = relevanceLabel(relevance);
  return label ? <span className="tldr-rel mono">{label}</span> : null;
}

export interface DeckListProps {
  lines: readonly DeckLine[];
  onMove: (pos: number, delta: -1 | 1) => void;
  onRemove: (sid: string) => void;
  disabled?: boolean;
}

export function DeckList({ lines, onMove, onRemove, disabled }: DeckListProps) {
  return (
    <ol className="deck">
      {lines.map((l, i) => {
        const n = i + 1;
        return (
          <li key={l.sid} className={l.missing ? 'deck__item is-missing' : 'deck__item'}>
            <span className="deck__ord mono" aria-hidden="true">
              {String(n).padStart(2, '0')}
            </span>
            <div className="deck__body">
              <p className="deck__text">{l.text}</p>
              {l.missing ? <p className="deck__missing">No longer in the article</p> : null}
              <p className="deck__meta">
                {l.source === 'jev' ? 'Jev' : 'Added by you'}
                {relevanceLabel(l.relevance) ? (
                  <>
                    {' · '}
                    <RelevanceTag relevance={l.relevance} />
                  </>
                ) : null}
              </p>
            </div>
            <div className="deck__tools">
              <button
                type="button"
                className="iconbtn deck__btn"
                onClick={() => onMove(i, -1)}
                disabled={disabled || i === 0}
                aria-label={`Move line ${n} up`}
              >
                ↑
              </button>
              <button
                type="button"
                className="iconbtn deck__btn"
                onClick={() => onMove(i, 1)}
                disabled={disabled || i === lines.length - 1}
                aria-label={`Move line ${n} down`}
              >
                ↓
              </button>
              <button
                type="button"
                className="iconbtn deck__btn"
                onClick={() => onRemove(l.sid)}
                disabled={disabled}
                aria-label={`Remove line ${n}`}
              >
                ✕
              </button>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
