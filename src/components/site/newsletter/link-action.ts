// The unsubscribe link page's button logic (pure, isomorphic; spec/ui.md §3 "Newsletter link pages"):
// POST the token to the JSON route, map the response to an outcome, outcome → copy. The confirm link
// has no button any more — it confirms on open (owner decision 2026-10-19).

import { LINK_COPY } from './LinkPage';

export type LinkOutcome =
  | { kind: 'done' }
  | { kind: 'expired' }
  | { kind: 'invalid' }
  | { kind: 'rate_limited'; minutes: number }
  | { kind: 'failed' };

export const UNSUBSCRIBE_ACTION = { api: '/api/newsletter/unsubscribe', button: 'Yes, unsubscribe me' } as const;

export const LINK_FAILED_TEXT = 'Something went wrong — try again.';

export async function postUnsubscribe(token: string, fetchImpl: typeof fetch = fetch): Promise<LinkOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(UNSUBSCRIBE_ACTION.api, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ token, source: 'email_link' }),
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    return { kind: 'failed' };
  }
  if (res.ok) return { kind: 'done' };
  if (res.status === 410) return { kind: 'expired' };
  if (res.status === 404) return { kind: 'invalid' };
  if (res.status === 429) {
    const sec = Number(res.headers.get('retry-after'));
    return { kind: 'rate_limited', minutes: Math.max(1, Math.ceil((Number.isFinite(sec) ? sec : 0) / 60)) };
  }
  return { kind: 'failed' };
}

export function outcomeCopy(outcome: LinkOutcome): { heading: string; body: string } {
  switch (outcome.kind) {
    case 'done':
      return { heading: LINK_COPY.unsubscribed.heading, body: LINK_COPY.unsubscribed.body() };
    case 'expired':
      return { heading: LINK_COPY.expired.heading, body: LINK_COPY.expired.body() };
    case 'invalid':
      return { heading: LINK_COPY.invalid.heading, body: LINK_COPY.invalid.body() };
    case 'rate_limited':
      return { heading: LINK_COPY.rateLimited.heading, body: LINK_COPY.rateLimited.body(outcome.minutes) };
    case 'failed':
      return { heading: LINK_COPY.failed.heading, body: LINK_FAILED_TEXT };
  }
}
