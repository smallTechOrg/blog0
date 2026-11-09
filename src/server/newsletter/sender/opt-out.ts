// The one rule for provider-side opt-outs (spec/architecture.md §13.3; newsletter-issues.md
// "Assumed (fix)"): blog0 owns the list, but an opt-out anywhere wins. A provider opt-out
// (blocklist, or a list-level unsubscribe from the List-Unsubscribe header / the provider's own
// unsubscribe page) is applied to blog0 — and blocks any re-add at the provider — unless blog0's
// latest consent / confirmation is strictly NEWER than the opt-out (a fresh double opt-in after it).
// Used by `newsletter:tick` (pullSuppressions) and by the sync (`syncSubscriber` → sync.ts).

type When = Date | string | null | undefined;

function ms(value: When): number {
  if (value === null || value === undefined) return 0;
  const t = (value instanceof Date ? value : new Date(value)).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/** blog0's latest consent / confirmation instant in ms (0 when it has neither). */
export function latestConsentMs(consent: { consentedAt: When; confirmedAt: When }): number {
  return Math.max(ms(consent.consentedAt), ms(consent.confirmedAt));
}

/**
 * True when the provider opt-out at `optOutAt` must win over blog0's consent: it is newer than the
 * latest consent / confirmation or equal to it (a tie goes to the opt-out — an opt-out anywhere wins). An
 * unparseable opt-out timestamp fails safe: the opt-out wins.
 */
export function providerOptOutWins(optOutAt: Date, consent: { consentedAt: When; confirmedAt: When }): boolean {
  const at = optOutAt.getTime();
  if (Number.isNaN(at)) return true;
  return at >= latestConsentMs(consent);
}
