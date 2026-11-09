import 'server-only';

import { fmtDate } from '@/lib/format-date';

import { getConfig } from '../config';
import type { NewsletterSubscriberRow } from '../db/schema';

import { signUnsubscribeToken } from './tokens';

// Absolute newsletter links under BLOG0_PUBLIC_BASE_URL and the consent line every message carries
// (spec/architecture.md §13.1 links.ts).

export const CONFIRM_PATH = '/newsletter/confirm';
export const UNSUBSCRIBE_PATH = '/newsletter/unsubscribe';
/** The confirm link's result page (GET /newsletter/confirm 303s here — confirm-on-open, owner decision 2026-10-19). */
export const CONFIRMED_PATH = '/newsletter/confirmed';
export const CONFIRM_RESULT_STATUSES = ['ok', 'already', 'expired', 'invalid', 'limited'] as const;
export type ConfirmResultStatus = (typeof CONFIRM_RESULT_STATUSES)[number];
/** RFC 8058 one-click target: the POST endpoint itself (a GET there 303s to the page). */
export const ONE_CLICK_UNSUBSCRIBE_PATH = '/api/newsletter/unsubscribe';

function base(): string {
  return getConfig().publicBaseUrl.replace(/\/+$/, '');
}

export function confirmUrl(token: string): string {
  return `${base()}${CONFIRM_PATH}?t=${encodeURIComponent(token)}`;
}

/** The subscriber's permanent one-click unsubscribe link (signed with `unsubscribeSigningSecret()`). */
export function unsubscribeUrl(subscriberId: string): string {
  return `${base()}${UNSUBSCRIBE_PATH}?t=${encodeURIComponent(unsubscribeToken(subscriberId))}`;
}

/**
 * The `List-Unsubscribe` header target (RFC 8058): mail providers POST `List-Unsubscribe=One-Click`
 * straight to this URL, so it must be the API route, not the page. Visible links stay `unsubscribeUrl`.
 */
export function oneClickUnsubscribeUrl(subscriberId: string): string {
  return `${base()}${ONE_CLICK_UNSUBSCRIBE_PATH}?t=${encodeURIComponent(unsubscribeToken(subscriberId))}`;
}

/**
 * The relative `Location` of the confirm result page (relative on purpose: the reader stays on the
 * origin that served the link even when it differs from BLOG0_PUBLIC_BASE_URL). `minutes` only for `limited`.
 */
export function confirmResultLocation(status: ConfirmResultStatus, minutes?: number): string {
  const q = new URLSearchParams({ status });
  if (status === 'limited' && minutes !== undefined) q.set('m', String(minutes));
  return `${CONFIRMED_PATH}?${q.toString()}`;
}

/** The page link for a token already in hand (the GET fallback of the one-click URL). */
export function unsubscribePageUrl(token: string): string {
  return `${base()}${UNSUBSCRIBE_PATH}?t=${encodeURIComponent(token)}`;
}

/** The secret that signs NEW unsubscribe tokens: BLOG0_UNSUBSCRIBE_SECRET, else the session secret. */
export function unsubscribeSigningSecret(): string {
  const config = getConfig();
  return (config.newsletter.unsubscribeSecret ?? config.sessionSecret).reveal();
}

/** Every secret an unsubscribe token may verify against: the unsubscribe secret first, then the session secret (deduplicated). */
export function unsubscribeVerifySecrets(): string[] {
  const config = getConfig();
  const secrets = [config.newsletter.unsubscribeSecret?.reveal(), config.sessionSecret.reveal()].filter((s): s is string => s !== undefined);
  return [...new Set(secrets)];
}

export function unsubscribeToken(subscriberId: string): string {
  return signUnsubscribeToken(subscriberId, unsubscribeSigningSecret());
}

/** The public privacy page (`/privacy`) under BLOG0_PUBLIC_BASE_URL. */
export function privacyUrl(): string {
  return `${base()}/privacy`;
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
