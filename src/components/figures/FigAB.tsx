'use client';

import { useState } from 'react';

import { cx } from '@/components/design/motion';

/* --- Figure 2: two companies, and a question worth answering ---------- */
export const FIG_AB = {
  q: 'Which one are you building?',
  s: 'AI strategy starts with knowing what AI can’t do.',
  cols: [
    {
      key: 'a',
      name: 'Company A',
      quote: '“We’re AI-first!”',
      title: 'Bought 12 AI tools',
      lines: ['Has a prompt engineer.', 'No one understands the infra.', 'Ships demos, not products.'],
      pill: 'Looks great on LinkedIn',
    },
    {
      key: 'b',
      name: 'Company B',
      quote: '“We’re boring about tech.”',
      title: 'Built the foundation',
      lines: ['Knows what breaks and why.', 'AI makes them 10x faster.', 'Ships for every user.'],
      pill: 'Wins the market quietly',
    },
  ],
} as const;

type ColKey = (typeof FIG_AB.cols)[number]['key'];

export function FigAB() {
  const [tab, setTab] = useState<ColKey>('a'); /* narrow screens only */
  const [said, setSaid] = useState<ColKey | null>(null);
  const f = FIG_AB;
  const picked = said ? f.cols.find((c) => c.key === said) : undefined;

  return (
    <figure className="fig">
      <div className="fig__head">
        <span className="fig__k">Two companies, same market</span>
        <span className="tag">Op-Ed</span>
      </div>

      {/* the tab pair only renders on a phone, where two columns would stack */}
      <div className="abtabs" role="tablist" aria-label="Compare the two companies">
        {f.cols.map((c) => (
          <button
            key={c.key}
            type="button"
            role="tab"
            className={cx('abtab', tab === c.key && 'is-on')}
            aria-selected={tab === c.key ? 'true' : 'false'}
            onClick={() => setTab(c.key)}
          >
            {c.name}
          </button>
        ))}
      </div>

      <div className="ab">
        {f.cols.map((c) => (
          <div
            key={c.key}
            className={cx('abc', 'abc--' + c.key, tab === c.key && 'is-shown', said && said !== c.key && 'is-dim')}
          >
            <div className="abc__h">{c.name}</div>
            <div className="abc__b">
              <p className="abc__q">{c.quote}</p>
              <p className="abc__t">{c.title}</p>
              {c.lines.map((l, i) => (
                <p key={i} className="abc__l">
                  {l}
                </p>
              ))}
              <div className="abc__foot">
                <span className="abc__pill">{c.pill}</span>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="poll">
        {picked ? (
          /* no invented crowd: the reader's own answer, reflected back */
          <div className="poll__said" role="status">
            <b>{'You’re building ' + picked.name + '.'}</b>
            <p>{picked.pill + '. ' + f.s}</p>
            <button type="button" className="poll__again" onClick={() => setSaid(null)}>
              Change answer
            </button>
          </div>
        ) : (
          <div>
            <p className="poll__q">{f.q}</p>
            <p className="poll__s">{f.s}</p>
            <div className="poll__row">
              {f.cols.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  className="btn-outline"
                  onClick={() => {
                    setSaid(c.key);
                    setTab(c.key);
                  }}
                >
                  {'I’m ' + c.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </figure>
  );
}
