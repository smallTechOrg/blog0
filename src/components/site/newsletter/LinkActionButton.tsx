'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';

import { LINK_ACTIONS, LINK_FAILED_TEXT, outcomeCopy, postLinkAction, type LinkKind, type LinkOutcome } from './link-action';

/* The newsletter link pages' interactive card (spec/ui.md §3, fix pass): a plain GET only shows this
   prompt; the button POSTs the token and the card then swaps to the outcome copy. While posting the
   button reads "Working…" and is disabled; a network error re-enables it with a retry line. */

export interface LinkActionButtonProps {
  kind: LinkKind;
  token: string;
  /** Wordmark, used in "Back to …". */
  brand: string;
  /** Brand name, used in the confirmed copy and the unsubscribe prompt. */
  brandName: string;
}

export function LinkActionButton({ kind, token, brand, brandName }: LinkActionButtonProps) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<LinkOutcome | null>(null);
  const [retry, setRetry] = useState(false);
  const flight = useRef(false);

  async function press() {
    if (flight.current) return;
    flight.current = true;
    setBusy(true);
    setRetry(false);
    const result = await postLinkAction(kind, token);
    flight.current = false;
    setBusy(false);
    if (result.kind === 'failed') setRetry(true);
    else setOutcome(result);
  }

  if (outcome) {
    const copy = outcomeCopy(kind, outcome, brandName);
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

  const heading = kind === 'confirm' ? 'Confirm your subscription' : `Unsubscribe from ${brandName}?`;
  return (
    <main className="col">
      <section className="nl-page" aria-labelledby="nl-page-h">
        <span className="tag">Newsletter</span>
        <h1 id="nl-page-h">{heading}</h1>
        <p>
          {kind === 'confirm'
            ? `One click and ${brandName} issues start landing in this inbox.`
            : 'You won’t get another issue. You can sign up again any time.'}
        </p>
        <button type="button" className="btn" disabled={busy} aria-busy={busy} onClick={() => void press()}>
          {busy ? 'Working…' : LINK_ACTIONS[kind].button}
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
