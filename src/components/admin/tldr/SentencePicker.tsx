'use client';

import type { SentenceDto } from '@/lib/api/dto';

// "Article lines" (spec/ui.md §4 SentencePicker): every sentence of the saved revision (SMA-35: any
// length), in article order grouped under their headings, one checkbox each (checking adds the line to
// the deck; unchecking removes it). SMA-52: building the deck by hand is the default, so there is no
// relevance anywhere here — the AI is an optional add-on at the bottom of the tab.

export interface SentencePickerProps {
  sentences: readonly SentenceDto[];
  chosen: ReadonlySet<string>;
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

export function SentencePicker({ sentences, chosen, onToggle, disabled }: SentencePickerProps) {
  if (sentences.length === 0) {
    return <p className="admin-muted">No sentences in the saved article yet.</p>;
  }
  return (
    <div className="picker">
      {groupByHeading(sentences).map((g) => (
        <fieldset key={g.key} className="picker__group" data-order="article">
          <legend className="picker__head">{g.heading || 'Intro'}</legend>
          {g.items.map((s) => {
            const on = chosen.has(s.sid);
            return (
              <label key={s.sid} className={on ? 'picker__line is-on' : 'picker__line'} data-sid={s.sid}>
                <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => onToggle(s, e.target.checked)} />
                <span className="picker__body">
                  <span className="picker__text">{s.text}</span>
                </span>
              </label>
            );
          })}
        </fieldset>
      ))}
    </div>
  );
}
