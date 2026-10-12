// Phase 2 DTOs (spec/api.md → "Shared DTOs" additions + "Endpoints — Phase 2"), transcribed for
// the Phase 2 slices to import. Phase 1 shapes stay in ./dto.ts; this file only adds and widens.
// Pure types + the shared site-settings limits (used by the server schema and the admin form).

import type { FormatStatus, GenerationDto, HealthDto, SentenceDto, DeckSlideDto } from './dto';

// ---------------------------------------------------------------------------------------------
// Widened Phase 1 shapes
// ---------------------------------------------------------------------------------------------

/**
 * `TldrStateDto` as of Phase 2: adds `jevAvailable` — false only when no OpenRouter key is
 * configured (designer mode); the TLDR tab then disables Generate and shows the no-key notice.
 */
export interface TldrStateDto {
  status: FormatStatus;
  bounds: { min: number; max: number; target: number } | null; // null when 0 eligible sentences
  sentences: SentenceDto[]; // current revision, eligible only
  draft: { slides: DeckSlideDto[]; revisionId: string; updatedAt: string; updatedBy: string } | null;
  published: { slides: Array<{ text: string }>; publishedAt: string } | null;
  latestGeneration: GenerationDto | null;
  jevAvailable: boolean;
}

export type DbEngine = 'postgres' | 'pglite';

/** GET /api/health → data, with `dbEngine` (added in Phase 2, S2.8). */
export interface HealthPhase2Dto extends HealthDto {
  dbEngine?: DbEngine;
}

/** Error code (503): designer mode without an OpenRouter key; Generate refused before any row. */
export const LLM_NOT_CONFIGURED = 'LLM_NOT_CONFIGURED';

// ---------------------------------------------------------------------------------------------
// GET /api/public/articles/:slug/tldr (none) — published only, else 404
// ---------------------------------------------------------------------------------------------

export interface PublicTldrDto {
  slug: string;
  title: string;
  topic: string;
  dek: string;
  meta: string;
  slides: Array<{ text: string }>;
  disclosure: string;
  times: { read: number; tldr: number; listen: number | null };
  shareUrl: string;
}

// ---------------------------------------------------------------------------------------------
// POST /api/newsletter (none)
// ---------------------------------------------------------------------------------------------

export interface NewsletterSubscribeRequest {
  email: string;
  name?: string;
}
/** Also returned for an already-subscribed address (no enumeration). RATE_LIMITED: 10/IP/hour. */
export interface NewsletterSubscribeResponse {
  subscribed: true;
}

// ---------------------------------------------------------------------------------------------
// GET /api/admin/subscribers (admin) — `?format=csv` downloads CSV instead
// ---------------------------------------------------------------------------------------------

export interface SubscriberDto {
  email: string;
  name: string;
  createdAt: string;
  status: string;
}
export interface SubscribersResponse {
  subscribers: SubscriberDto[];
  total: number;
}

// ---------------------------------------------------------------------------------------------
// GET / PATCH /api/admin/site (admin)
// ---------------------------------------------------------------------------------------------

/** The admin-editable part of the site record (wordmark, slug, timezone are not editable here). */
export interface SiteSettingsDto {
  tagline: string;
  contactEmail: string;
  aboutStrap: string;
  aboutStand: string;
  aboutBodyMd: string;
  socialXUrl: string | null;
  socialLinkedinUrl: string | null;
}

/** GET → data, and PATCH → data. */
export interface SiteSettingsResponse {
  site: SiteSettingsDto;
}

/**
 * PATCH body: any subset. Texts are trimmed; required texts must be non-blank; social URLs are
 * http(s) or blank/null (blank clears it, and the footer hides that icon). Unknown keys → 400.
 */
export type SiteSettingsPatch = Partial<SiteSettingsDto>;

/** Max lengths, shared by the server schema and the admin form. */
export const SITE_SETTINGS_LIMITS = {
  tagline: 160,
  contactEmail: 254,
  aboutStrap: 120,
  aboutStand: 400,
  aboutBodyMd: 10_000,
  socialUrl: 500,
} as const;
