'use client';

import { relevanceLabel } from '../labels';

import type { DeckLine } from './deck-edit';

// The ordered draft deck (spec/ui.md §4 TLDR tab → Deck): ordinal, verbatim line, meta line
// ("AI · relevance 0.82" / "Added by you · relevance 0.41"; the score is left out when null),
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
  /** Edit an image line's caption / alt text (SMA-49). */
  onEditImage?: (sid: string, patch: { text?: string; alt?: string }) => void;
  disabled?: boolean;
}

export function DeckList({ lines, onMove, onRemove, onEditImage, disabled }: DeckListProps) {
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
              {l.image ? (
                <div className="deck__image">
                  {/* eslint-disable-next-line @next/next/no-img-element -- admin thumbnail of an uploaded image */}
                  <img className="deck__thumb" src={l.image.url} alt={l.image.alt} width={96} />
                  <div className="deck__imgfields">
                    <input
                      className="admin-input"
                      type="text"
                      maxLength={200}
                      placeholder="Caption (optional)"
                      aria-label={`Caption for slide ${n}`}
                      value={l.text}
                      disabled={disabled}
                      onChange={(e) => onEditImage?.(l.sid, { text: e.target.value })}
                    />
                    <input
                      className="admin-input"
                      type="text"
                      maxLength={200}
                      placeholder="Alt text — describe the image"
                      aria-label={`Alt text for slide ${n}`}
                      value={l.image.alt}
                      disabled={disabled}
                      onChange={(e) => onEditImage?.(l.sid, { alt: e.target.value })}
                    />
                  </div>
                </div>
              ) : (
                <p className="deck__text">{l.text}</p>
              )}
              {l.missing ? <p className="deck__missing">No longer in the article</p> : null}
              <p className="deck__meta">
                {l.source === 'jev' ? 'AI' : l.image ? 'Image' : 'Added by you'}
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
