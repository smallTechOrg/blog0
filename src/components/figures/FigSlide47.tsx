'use client';

import { useState } from 'react';

/* ============================================================
   In-article figures (spec/design/design-app.js)
   ------------------------------------------------------------
   Both come from this article's source doc, where they were flat
   images. The words are the author's; only the presentation is new.
   Each owns its own state, so opening one never re-renders the prose
   around it.
   ============================================================ */

/* --- Figure 1: the setup is shown, the punchline is asked for --------- */
export const FIG_SLIDE47 = {
  deck: 'Slide 47 of your AI strategy deck',
  claim: 'We are now an AI company.',
  sub: '(We told ChatGPT to write our roadmap.)',
  told: ['10x productivity', 'Zero tech overhead'],
  happened: ['3 prod outages', '1 very quiet engineer'],
  kick: 'AI strategy without tech foundation = expensive theatre.',
  cap: 'Your AI strategy needs a tech strategy first.',
} as const;

export function FigSlide47() {
  const [open, setOpen] = useState(false);
  const f = FIG_SLIDE47;
  return (
    <figure className="fig">
      <div className="fig__head">
        <span className="fig__k">The pitch</span>
        <span className="tag">Satire</span>
      </div>
      <div className="deck47">
        <div className="deck47__bar">{f.deck}</div>
        <div className="deck47__body">
          <p className="deck47__claim">{f.claim}</p>
          <p className="deck47__sub">{f.sub}</p>
          <div className="cr">
            <div className="cr__col">
              <p className="cr__h">What we told investors</p>
              {f.told.map((t, i) => (
                <p key={i} className="cr__l">
                  {t}
                </p>
              ))}
            </div>
            <div className="cr__col cr__col--real">
              <div className={open ? 'cr__reveal' : ''} style={open ? undefined : { visibility: 'hidden' }}>
                <p className="cr__h">What actually happened</p>
                {f.happened.map((t, i) => (
                  <p key={i} className="cr__l">
                    {t}
                  </p>
                ))}
              </div>
              {open ? null : (
                <div className="cr__veil">
                  <button
                    type="button"
                    className="cr__veilbtn"
                    onClick={() => setOpen(true)}
                    aria-label="Reveal what actually happened"
                  >
                    Reveal what happened
                  </button>
                </div>
              )}
            </div>
          </div>
          <p className="deck47__kick">{f.kick}</p>
        </div>
      </div>
      <figcaption className="fig__cap">{f.cap}</figcaption>
    </figure>
  );
}
