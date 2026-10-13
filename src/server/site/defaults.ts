import 'server-only';

import { DEFAULT_CONSENT_TEXT, DEFAULT_CONSENT_VERSION, type NewSiteRow } from '../db/schema';

// Seed values for the `site` row (spec/data.md → site; design constants from spec/design/design-app.js).
// Shared by the test helper (resetDb) and `pnpm db:seed`. The brand is blog0 everywhere
// (spec/architecture.md divergence 25); rows seeded with the design's "log0" are upgraded by
// `upgradeLegacyBrand` (src/server/site/service.ts) during `pnpm db:seed`.

/** The design's wordmark, replaced by `blog0` (divergence 25); only used to upgrade old rows. */
export const LEGACY_WORDMARK = 'log0';

/** Design `ABOUT_BODY_FULL` (divergence #14: no "Placeholder" text in public). */
export const ABOUT_BODY_FULL = [
  'We write about ideas, technologies, and the systems behind them. Some pieces explain how something works. Others take a position and show the reasoning behind it. Others follow what has changed and ask whether the change actually matters.',
  'Our work is built to be read beyond the news cycle, referenced in the middle of a decision, and revisited when the question comes up again.',
] as const;

export const SITE_DEFAULTS = {
  slug: 'blog0',
  brandName: 'blog0',
  wordmark: 'blog0',
  publisherName: 'smallTech',
  tagline: 'the meaning of life, universe, and everything',
  contactEmail: 'hello@logzero.blog',
  aboutStrap: 'Less noise. More signal.',
  aboutStand: 'A publication from smallTech on the parts of applied AI that are hard to measure and easy to oversell.',
  aboutBodyMd: ABOUT_BODY_FULL.join('\n\n'),
  socialXUrl: null,
  socialLinkedinUrl: null,
  timezone: 'Asia/Kolkata',
  // Phase 7 (spec/data.md → site): newsletter settings — manual mode, no auto-send, the seeded consent line.
  newsletterMode: 'manual',
  newsletterAutoSend: false,
  newsletterDigestDays: 7,
  newsletterDigestPosts: 3,
  newsletterConsentText: DEFAULT_CONSENT_TEXT,
  newsletterConsentVersion: DEFAULT_CONSENT_VERSION,
  newsletterModeSetAt: null,
} as const satisfies Omit<NewSiteRow, 'id' | 'createdAt' | 'updatedAt'>;

/** The seed row for a given site slug (BLOG0_SITE_SLUG). */
export function siteSeedFor(slug: string): Omit<NewSiteRow, 'id' | 'createdAt' | 'updatedAt'> {
  return { ...SITE_DEFAULTS, slug };
}
