'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import type { NewsletterDelivery, NewsletterSubscribeRequest } from '@/lib/api/dto';

/* The signup (design NewsletterForm): name (optional), then e-mail and the
   arrow in one row. Posts to /api/newsletter (capability newsletter-list) with
   the page it was on (`sourceUrl`); the `.ft-micro` line is the site's consent
   text, recorded on the signup. Double opt-in: success means "check your inbox"
   (div. 15 amended). The address is checked here first so a typo never costs a
   request.

   Stage A (spec/ui.md §3): the success copy follows the response's `delivery` (sent / recorded /
   failed — a failed send keeps the form for a retry, role=alert), and the body carries the
   honeypot `website` and `fillMs` (ms since the form mounted) for the server's bot check. */

export const NL_INVALID = 'Enter a valid email, like you@company.com.';
export const NL_FAILED = 'That didn’t go through. Try again?';
export const NL_DONE = 'Almost there — check your inbox and confirm.';
export const NL_DELIVERY_COPY: Record<NewsletterDelivery, string> = {
  sent: NL_DONE,
  recorded: 'Signup recorded — this environment doesn’t send email.',
  failed: 'We couldn’t send your confirmation email — please try again shortly.',
};

const EMAIL_RE = /^\S+@\S+\.\S+$/;
const DELIVERIES: readonly NewsletterDelivery[] = ['sent', 'recorded', 'failed'];

export type SignupOutcome = { kind: 'done'; delivery: NewsletterDelivery } | { kind: 'invalid' } | { kind: 'failed' };

/** HTTP status + parsed envelope → outcome. A success without a known `delivery` reads as `sent`. */
export function signupOutcome(status: number, env: unknown): SignupOutcome {
  if (status === 400) return { kind: 'invalid' };
  const e = env as { ok?: unknown; data?: { delivery?: unknown } } | null;
  if (status < 200 || status >= 300 || !e || e.ok !== true) return { kind: 'failed' };
  const d = e.data?.delivery;
  return { kind: 'done', delivery: DELIVERIES.includes(d as NewsletterDelivery) ? (d as NewsletterDelivery) : 'sent' };
}

/** The POST /api/newsletter body (spec/api.md): name only when given; fillMs a whole number ≥ 0. */
export function signupBody(f: { email: string; name: string; sourceUrl: string; website: string; fillMs: number }): NewsletterSubscribeRequest {
  return {
    email: f.email,
    ...(f.name ? { name: f.name } : {}),
    sourceUrl: f.sourceUrl,
    website: f.website,
    fillMs: Math.max(0, Math.round(Number.isFinite(f.fillMs) ? f.fillMs : 0)),
  };
}

function currentSourceUrl(): string {
  if (typeof location === 'undefined') return '/';
  const path = (location.pathname || '/') + (location.search || '');
  return path.startsWith('/') && !path.startsWith('//') ? path.slice(0, 500) : '/';
}

/* 400 → the server disagreed with the address (show the design's hint);
   anything else that is not a success envelope → the try-again message. */
async function submitSubscribe(body: NewsletterSubscribeRequest): Promise<SignupOutcome> {
  try {
    const res = await fetch('/api/newsletter', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
    });
    return signupOutcome(res.status, await res.json().catch(() => null));
  } catch {
    return { kind: 'failed' };
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
  const [done, setDone] = useState<NewsletterDelivery | null>(null);
  const [err, setErr] = useState('');
  const honeypot = useRef<HTMLInputElement>(null);
  const mountedAt = useRef<number | null>(null);

  useEffect(() => {
    mountedAt.current = performance.now();
  }, []);

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
    const outcome = await submitSubscribe(
      signupBody({
        email: address,
        name: name.trim(),
        sourceUrl: currentSourceUrl(),
        website: honeypot.current?.value ?? '',
        fillMs: mountedAt.current === null ? 0 : performance.now() - mountedAt.current,
      }),
    );
    setBusy(false);
    if (outcome.kind === 'done' && outcome.delivery !== 'failed') setDone(outcome.delivery);
    else if (outcome.kind === 'done') setErr(NL_DELIVERY_COPY.failed);
    else setErr(outcome.kind === 'invalid' ? NL_INVALID : NL_FAILED);
  }

  const sendFailed = err === NL_DELIVERY_COPY.failed;

  return (
    <section className="ft-left" id="newsletter" aria-labelledby="nl-h">
      <h2 className="ft-h2" id="nl-h">
        One issue a week, on what actually changed
      </h2>
      {done ? (
        <p className="ft-done" role="status">
          {NL_DELIVERY_COPY[done]}
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
          {/* honeypot: people never see or reach it; a bot that fills it is dropped silently */}
          <div className="ft-hp" aria-hidden="true">
            <label htmlFor="nl-website">Website</label>
            <input id="nl-website" name="website" type="text" tabIndex={-1} autoComplete="off" defaultValue="" ref={honeypot} />
          </div>
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
          <p className="ft-st" id="nl-st" aria-live={sendFailed ? undefined : 'polite'} role={sendFailed ? 'alert' : undefined}>
            {err}
          </p>
        </form>
      )}
    </section>
  );
}
