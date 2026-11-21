'use client';

import { useState, type KeyboardEvent } from 'react';

import type { SentenceDto } from '@/lib/api/dto';

import { hasScores, sectionOf, sortByRelevance, type PickerOrder } from './deck-edit';
import { RelevanceTag } from './DeckList';

// "Article lines" (spec/ui.md §4 SentencePicker): every sentence of the saved revision (SMA-35: any length),
// one checkbox each (checking adds the line to the deck; unchecking removes it). A segmented
// switch sorts them **By relevance** (flat list, highest score first, unscored last, each row
// with its section caption) or **In article order** (grouped under heading paths). By relevance
// is the default whenever any sentence has a score; with no scores the switch is disabled.
// The choice is local UI state, never persisted.

export interface SentencePickerProps {
  sentences: readonly SentenceDto[];
  chosen: ReadonlySet<string>;
  onToggle: (sentence: SentenceDto, checked: boolean) => void;
  disabled?: boolean;
  /** Initial sort choice (tests); otherwise By relevance when scores exist. */
  initialOrder?: PickerOrder;
}

interface Group {
  key: string;
  heading: string;
  items: SentenceDto[];
}

export function groupByHeading(sentences: readonly SentenceDto[]): Group[] {
  const groups: Group[] = [];
  for (const s of sentences) {
    const heading = s.headingPath.join(' › ');
    const last = groups[groups.length - 1];
    if (last && last.heading === heading) last.items.push(s);
    else groups.push({ key: `${groups.length}-${heading}`, heading, items: [s] });
  }
  return groups;
}

export const NO_SCORES_TITLE = 'No scores yet — generate with AI';

const ORDERS: ReadonlyArray<{ value: PickerOrder; label: string }> = [
  { value: 'relevance', label: 'By relevance' },
  { value: 'article', label: 'In article order' },
];

export function SentencePicker({ sentences, chosen, onToggle, disabled, initialOrder }: SentencePickerProps) {
  // null = the writer hasn't chosen: follow the default (so a fresh Generate flips to By relevance).
  const [choice, setChoice] = useState<PickerOrder | null>(initialOrder ?? null);
  const scored = hasScores(sentences);
  const order: PickerOrder = scored ? (choice ?? 'relevance') : 'article';

  if (sentences.length === 0) {
    return <p className="admin-muted">No sentences in the saved article yet.</p>;
  }

  function onSwitchKey(e: KeyboardEvent<HTMLDivElement>): void {
    if (!scored) return;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const next: PickerOrder = order === 'relevance' ? 'article' : 'relevance';
    setChoice(next);
    const target = e.currentTarget.querySelector<HTMLButtonElement>(`[data-order="${next}"]`);
    target?.focus();
  }

  function row(s: SentenceDto, withSection: boolean) {
    const on = chosen.has(s.sid);
    return (
      <label key={s.sid} className={on ? 'picker__line is-on' : 'picker__line'} data-sid={s.sid}>
        <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => onToggle(s, e.target.checked)} />
        <span className="picker__body">
          <RelevanceTag relevance={s.relevance} />
          <span className="picker__text">{s.text}</span>
          {withSection ? <span className="picker__sec">{sectionOf(s)}</span> : null}
        </span>
      </label>
    );
  }

  return (
    <div className="picker">
      <div
        className="segsw"
        role="radiogroup"
        aria-label="Sort article lines"
        title={scored ? undefined : NO_SCORES_TITLE}
        onKeyDown={onSwitchKey}
      >
        {ORDERS.map((o) => {
          const on = order === o.value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              data-order={o.value}
              className={on ? 'segsw__opt is-on' : 'segsw__opt'}
              disabled={!scored}
              title={scored ? undefined : NO_SCORES_TITLE}
              onClick={() => setChoice(o.value)}
            >
              {o.label}
            </button>
          );
        })}
      </div>
      {order === 'relevance' ? (
        <div className="picker__flat" data-order="relevance">
          {sortByRelevance(sentences).map((s) => row(s, true))}
        </div>
      ) : (
        groupByHeading(sentences).map((g) => (
          <fieldset key={g.key} className="picker__group" data-order="article">
            <legend className="picker__head">{g.heading || 'Intro'}</legend>
            {g.items.map((s) => row(s, false))}
          </fieldset>
        ))
      )}
    </div>
  );
}
