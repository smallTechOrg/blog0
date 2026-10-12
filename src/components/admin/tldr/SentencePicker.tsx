'use client';

import type { SentenceDto } from '@/lib/api/dto';

import { MAX_DECK_LINES } from './deck-edit';

// "Article lines" (spec/ui.md §4): every eligible sentence of the saved revision, grouped under
// its heading path, one checkbox each. Checking adds the line to the deck; unchecking removes it.

export interface SentencePickerProps {
  sentences: readonly SentenceDto[];
  chosen: ReadonlySet<string>;
  deckSize: number;
  onToggle: (sentence: SentenceDto, checked: boolean) => void;
  disabled?: boolean;
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

export function SentencePicker({ sentences, chosen, deckSize, onToggle, disabled }: SentencePickerProps) {
  const full = deckSize >= MAX_DECK_LINES;
  if (sentences.length === 0) {
    return <p className="admin-muted">No eligible sentences in the saved article yet (Jev only uses sentences of 5+ words).</p>;
  }
  return (
    <div className="picker">
      {full ? <p className="admin-hint">The deck holds at most {MAX_DECK_LINES} lines — remove one to add another.</p> : null}
      {groupByHeading(sentences).map((g) => (
        <fieldset key={g.key} className="picker__group">
          <legend className="picker__head">{g.heading || 'Opening'}</legend>
          {g.items.map((s) => {
            const on = chosen.has(s.sid);
            return (
              <label key={s.sid} className={on ? 'picker__line is-on' : 'picker__line'}>
                <input
                  type="checkbox"
                  checked={on}
                  disabled={disabled || (!on && full)}
                  onChange={(e) => onToggle(s, e.target.checked)}
                />
                <span>{s.text}</span>
              </label>
            );
          })}
        </fieldset>
      ))}
    </div>
  );
}
