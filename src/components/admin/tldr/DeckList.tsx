'use client';

import type { DeckLine } from './deck-edit';

// The ordered draft deck (spec/ui.md §4 TLDR tab → Deck): ordinal, verbatim line, reason
// ("Jev: …" / "Added by you"), ↑ ↓ ✕; lines that vanished from the text are flagged.

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
              <p className="deck__reason">{l.source === 'jev' ? `Jev: ${l.reason ?? '—'}` : 'Added by you'}</p>
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
