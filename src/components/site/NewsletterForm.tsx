'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';

/* The signup (design NewsletterForm): name (optional), then e-mail and the
   arrow in one row. Posts to /api/newsletter (capability newsletter-list) with
   the page it was on (`sourceUrl`); the `.ft-micro` line is the site's consent
   text, recorded on the signup. Double opt-in: success means "check your inbox"
   (div. 15 amended). The address is checked here first so a typo never costs a
   request. */

export const NL_INVALID = 'Enter a valid email, like you@company.com.';
export const NL_FAILED = 'That didn’t go through. Try again?';
export const NL_DONE = 'Almost there — check your inbox and confirm.';

const EMAIL_RE = /^\S+@\S+\.\S+$/;

type Outcome = 'ok' | 'invalid' | 'failed';

/* 400 → the server disagreed with the address (show the design's hint);
   anything else that is not a success envelope → the try-again message. */
function currentSourceUrl(): string {
  if (typeof location === 'undefined') return '/';
  const path = (location.pathname || '/') + (location.search || '');
  return path.startsWith('/') && !path.startsWith('//') ? path.slice(0, 500) : '/';
}

async function submitSubscribe(email: string, name: string): Promise<Outcome> {
  try {
    const res = await fetch('/api/newsletter', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ email, ...(name ? { name } : {}), sourceUrl: currentSourceUrl() }),
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (res.status === 400) return 'invalid';
    const env = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    return res.ok && env?.ok === true ? 'ok' : 'failed';
  } catch {
    return 'failed';
  }
}

export interface NewsletterFormProps {
  /** The consent line shown under the form (site.newsletterConsentText). */
  consentText: string;
}

export function NewsletterForm({ consentText }: NewsletterFormProps) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState('');

  async function submit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    if (busy) return;
    setErr('');
    const address = email.trim();
    if (!EMAIL_RE.test(address)) {
      setErr(NL_INVALID);
      return;
    }
    setBusy(true);
    const outcome = await submitSubscribe(address, name.trim());
    setBusy(false);
    if (outcome === 'ok') setDone(true);
    else setErr(outcome === 'invalid' ? NL_INVALID : NL_FAILED);
  }

  return (
    <section className="ft-left" id="newsletter" aria-labelledby="nl-h">
      <h2 className="ft-h2" id="nl-h">
        One issue a week, on what actually changed
      </h2>
      {done ? (
        <p className="ft-done" role="status">
          {NL_DONE}
        </p>
      ) : (
        <form noValidate onSubmit={(ev) => void submit(ev)}>
          <label className="sr" htmlFor="nl-name">
            Name (optional)
          </label>
          <input
            className="ft-fld"
            id="nl-name"
            type="text"
            placeholder="Name (optional)"
            autoComplete="name"
            maxLength={120}
            value={name}
            onChange={(ev) => setName(ev.target.value)}
          />
          <div className="ft-row">
            <label className="sr" htmlFor="nl-email">
              Email
            </label>
            <input
              className="ft-fld"
              id="nl-email"
              type="email"
              placeholder="E-mail"
              autoComplete="email"
              required
              maxLength={254}
              aria-invalid={err === NL_INVALID ? true : undefined}
              aria-describedby="nl-st"
              value={email}
              onChange={(ev) => {
                setEmail(ev.target.value);
                if (err) setErr('');
              }}
            />
            <button className="ft-go" type="submit" aria-label="Subscribe" disabled={busy}>
              {busy ? '…' : '→'}
            </button>
          </div>
          <p className="ft-micro">
            {consentText}{' '}
            <Link href="/privacy">Privacy</Link>
          </p>
          <p className="ft-st" id="nl-st" aria-live="polite">
            {err}
          </p>
        </form>
      )}
    </section>
  );
}
