import 'server-only';

import { ApiError } from '../http/api';
import { log } from '../log';

import { getNewsletterLinkThrottle } from './rate-limit';

// The shared confirm / unsubscribe link cap (spec/architecture.md §6 "Newsletter link throttling"),
// used by both the JSON routes (429 RATE_LIMITED + Retry-After) and the HTML pages (429 copy).

export interface LinkLimited {
  limited: true;
  retryAfterSec: number;
  /** Whole minutes for the page copy ("try again in N minutes"), at least 1. */
  retryMinutes: number;
}

export async function checkLink(key: { ip: string; siteId: string }, now = Date.now()): Promise<{ limited: false } | LinkLimited> {
  const check = await getNewsletterLinkThrottle().attempt(key, now);
  if (!check.limited) return { limited: false };
  return { limited: true, retryAfterSec: check.retryAfterSec, retryMinutes: Math.max(1, Math.ceil(check.retryAfterSec / 60)) };
}

/** JSON routes: throws 429 RATE_LIMITED with Retry-After. */
export async function throttleLink(key: { ip: string; siteId: string }, requestId: string, kind: 'confirm' | 'unsubscribe' | 'one_click'): Promise<void> {
  const check = await checkLink(key);
  if (!check.limited) return;
  log.info('newsletter.link', { request_id: requestId, kind, outcome: 'rate_limited' });
  throw new ApiError('RATE_LIMITED', 429, `Too many requests — try again in ${check.retryMinutes} minute${check.retryMinutes === 1 ? '' : 's'}.`, undefined, {
    'retry-after': String(check.retryAfterSec),
    'x-robots-tag': 'noindex',
  });
}
