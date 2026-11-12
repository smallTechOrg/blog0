import 'server-only';

import { DEFAULT_PRIVACY_TEXT, type NewSiteRow } from '../db/schema';

/** The footer signup's consent line for new sites (Linear SMA-6); "Read our Privacy Policy." follows it. */
export const SEED_CONSENT_TEXT = 'Only updates on the new articles. Nothing more.';
export const SEED_CONSENT_VERSION = 'v2';

// Seed values for the `site` row (spec/data.md → site; design constants from spec/design/design-app.js).
// Shared by the test helper (resetDb) and `pnpm db:seed`. The brand is blog0 everywhere
// (spec/architecture.md divergence 25); rows seeded with the design's "log0" are upgraded by
// `upgradeLegacyBrand` (src/server/site/service.ts) during `pnpm db:seed`.

/** The design's wordmark, replaced by `blog0` (divergence 25); only used to upgrade old rows. */
export const LEGACY_WORDMARK = 'log0';

/** The About body (Linear SMA-6; was the design `ABOUT_BODY_FULL`, divergence #14; reworded by the owner 2026-11-11 and 2026-11-12). */
export const ABOUT_BODY_FULL = [
  'We are a collective of engineers, designers and thinkers whose mission is to ensure tech enables the democratisation of power, not the concentration of it.',
  'On this publication, you will find articles on how to run an AI-native business in 2026, while also delving into the impact of AI on economics, politics and culture.',
] as const;

export const SITE_DEFAULTS = {
  slug: 'blog0',
  brandName: 'blog0',
  wordmark: 'blog0',
  publisherName: 'smallTech',
  tagline: "smallTech's official publication",
  contactEmail: 'contact@smalltech.in',
  aboutStrap: 'Fresh Hand-Typed Content Available Here.',
  // Home About is two columns: strap + stand on the left, the body on the right (Linear SMA-6 layout).
  aboutStand:
    'Welcome to blog0, the official publication of [smallTech](https://smalltech.in), a software company based in Bengaluru, India.',
  aboutBodyMd: ABOUT_BODY_FULL.join('\n\n'),
  socialXUrl: null,
  socialLinkedinUrl: 'https://www.linkedin.com/company/smalltechorg/', // owner, 2026-11-09
  timezone: 'Asia/Kolkata',
  // Phase 7 (spec/data.md → site): newsletter settings — manual mode, no auto-send, the seeded consent line.
  newsletterMode: 'manual',
  newsletterAutoSend: false,
  newsletterDigestDays: 7,
  newsletterDigestPosts: 3,
  // Linear SMA-6: the signup line's new wording is consent version v2. The column default stays v1
  // (DEFAULT_CONSENT_*, migration 0002) so no stored proof of consent changes meaning.
  newsletterConsentText: SEED_CONSENT_TEXT,
  newsletterConsentVersion: SEED_CONSENT_VERSION,
  newsletterModeSetAt: null,
  // Fix pass (0004): a plain-language DRAFT privacy page (the owner must review it) and no postal address.
  // `newsletterEraseSalt` is never seeded here — its column default is a fresh random value per row.
  privacyText: DEFAULT_PRIVACY_TEXT,
  newsletterPostalAddress: '',
} as const satisfies Omit<NewSiteRow, 'id' | 'createdAt' | 'updatedAt'>;

/** The seed row for a given site slug (BLOG0_SITE_SLUG). */
export function siteSeedFor(slug: string): Omit<NewSiteRow, 'id' | 'createdAt' | 'updatedAt'> {
  return { ...SITE_DEFAULTS, slug };
}
