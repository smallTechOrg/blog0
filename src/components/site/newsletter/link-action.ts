// The newsletter link pages' button logic (pure, isomorphic; spec/ui.md §3 "Newsletter link pages",
// fix pass): POST the token to the JSON route, map the response to an outcome, outcome → copy.

import { LINK_COPY } from './LinkPage';

export type LinkKind = 'confirm' | 'unsubscribe';

export type LinkOutcome =
  | { kind: 'done' }
  | { kind: 'expired' }
  | { kind: 'invalid' }
  | { kind: 'rate_limited'; minutes: number }
  | { kind: 'failed' };

export const LINK_ACTIONS = {
  confirm: { api: '/api/newsletter/confirm', button: 'Confirm my subscription' },
  unsubscribe: { api: '/api/newsletter/unsubscribe', button: 'Yes, unsubscribe me' },
} as const;

export const LINK_FAILED_TEXT = 'Something went wrong — try again.';

export async function postLinkAction(kind: LinkKind, token: string, fetchImpl: typeof fetch = fetch): Promise<LinkOutcome> {
  const body = kind === 'confirm' ? { token } : { token, source: 'email_link' };
  let res: Response;
  try {
    res = await fetchImpl(LINK_ACTIONS[kind].api, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
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

export function outcomeCopy(kind: LinkKind, outcome: LinkOutcome, brandName: string): { heading: string; body: string } {
  switch (outcome.kind) {
    case 'done':
      return kind === 'confirm'
        ? { heading: LINK_COPY.confirmed.heading, body: LINK_COPY.confirmed.body(brandName) }
        : { heading: LINK_COPY.unsubscribed.heading, body: LINK_COPY.unsubscribed.body() };
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
