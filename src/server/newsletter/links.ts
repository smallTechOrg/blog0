import 'server-only';

import { fmtDate } from '@/lib/format-date';

import { getConfig } from '../config';
import type { NewsletterSubscriberRow } from '../db/schema';

import { signUnsubscribeToken } from './tokens';

// Absolute newsletter links under BLOG0_PUBLIC_BASE_URL and the consent line every message carries
// (spec/architecture.md §13.1 links.ts).

export const CONFIRM_PATH = '/newsletter/confirm';
export const UNSUBSCRIBE_PATH = '/newsletter/unsubscribe';

function base(): string {
  return getConfig().publicBaseUrl.replace(/\/+$/, '');
}

export function confirmUrl(token: string): string {
  return `${base()}${CONFIRM_PATH}?t=${encodeURIComponent(token)}`;
}

/** The subscriber's permanent one-click unsubscribe link (signed with the session secret). */
export function unsubscribeUrl(subscriberId: string): string {
  return `${base()}${UNSUBSCRIBE_PATH}?t=${encodeURIComponent(unsubscribeToken(subscriberId))}`;
}

export function unsubscribeToken(subscriberId: string): string {
  return signUnsubscribeToken(subscriberId, getConfig().sessionSecret.reveal());
}

export interface ConsentLineSite {
  brandName: string;
  timezone: string;
}

/**
 * "You’re getting this because you subscribed at <brand> on <date> and confirmed on <date>."
 * A legacy-confirmed row (no consent date of its own) reads "…subscribed at <brand> and confirmed on <date>".
 */
export function consentLine(
  subscriber: Pick<NewsletterSubscriberRow, 'consentedAt' | 'confirmedAt' | 'createdAt' | 'source'>,
  site: ConsentLineSite,
): string {
  const confirmed = subscriber.confirmedAt ? fmtDate(subscriber.confirmedAt, site.timezone) : null;
  const signedUp = subscriber.source === 'legacy' || !subscriber.consentedAt ? null : fmtDate(subscriber.consentedAt, site.timezone);
  const at = signedUp ? `subscribed at ${site.brandName} on ${signedUp}` : `subscribed at ${site.brandName}`;
  return confirmed ? `You’re getting this because you ${at} and confirmed on ${confirmed}.` : `You’re getting this because you ${at}.`;
}
