'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';

import { LINK_FAILED_TEXT, outcomeCopy, postUnsubscribe, UNSUBSCRIBE_ACTION, type LinkOutcome } from './link-action';

/* The unsubscribe link page's interactive card (spec/ui.md §3, fix pass): a plain GET only shows this
   prompt; the button POSTs the token and the card then swaps to the outcome copy. While posting the
   button reads "Working…" and is disabled; a network error re-enables it with a retry line. (The
   confirm link confirms on open — owner decision 2026-10-19 — so it has no button.) */

export interface LinkActionButtonProps {
  token: string;
  /** Wordmark, used in "Back to …". */
  brand: string;
  /** Brand name, used in the prompt. */
  brandName: string;
}

export function LinkActionButton({ token, brand, brandName }: LinkActionButtonProps) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<LinkOutcome | null>(null);
  const [retry, setRetry] = useState(false);
  const flight = useRef(false);

  async function press() {
    if (flight.current) return;
    flight.current = true;
    setBusy(true);
    setRetry(false);
    const result = await postUnsubscribe(token);
    flight.current = false;
    setBusy(false);
    if (result.kind === 'failed') setRetry(true);
    else setOutcome(result);
  }

  if (outcome) {
    const copy = outcomeCopy(outcome);
    return (
      <main className="col">
        <section className="nl-page" aria-labelledby="nl-page-h">
          <span className="tag">Newsletter</span>
          <h1 id="nl-page-h">{copy.heading}</h1>
          <p role="status">{copy.body}</p>
          <Link className="btn-outline" href="/">
            Back to {brand}
          </Link>
        </section>
      </main>
    );
  }

  return (
    <main className="col">
      <section className="nl-page" aria-labelledby="nl-page-h">
        <span className="tag">Newsletter</span>
        <h1 id="nl-page-h">Unsubscribe from {brandName}?</h1>
        <p>You won’t get another issue. You can sign up again any time.</p>
        <button type="button" className="btn" disabled={busy} aria-busy={busy} onClick={() => void press()}>
          {busy ? 'Working…' : UNSUBSCRIBE_ACTION.button}
        </button>
        {retry ? (
          <p className="nl-page__err" role="alert">
            {LINK_FAILED_TEXT}
          </p>
        ) : null}
      </section>
    </main>
  );
}
