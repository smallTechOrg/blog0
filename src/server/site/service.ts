import 'server-only';

import { and, eq, or } from 'drizzle-orm';
import { z } from 'zod';

import { SITE_SETTINGS_LIMITS, type SiteSettingsDto, type SiteSettingsPatch } from '@/lib/api/dto';

import type { Db } from '../db/client';
import { getDb } from '../db/client';
import { site, type SiteRow } from '../db/schema';
import { ApiError } from '../http/api';
import { log } from '../log';

import { invalidateCurrentSite } from './current';
import { LEGACY_WORDMARK, SITE_DEFAULTS } from './defaults';

// Site settings (Admin → Site; spec/api.md GET/PATCH /api/admin/site, spec/capabilities/reader-site.md):
// any admin edits the tagline, contact mail, About strap/stand/body and social URLs. A save
// invalidates the process's current-site cache so home and /about show it on the next load.
// Also the idempotent brand upgrade `pnpm db:seed` runs on rows seeded with the design's "log0".

const L = SITE_SETTINGS_LIMITS;

const requiredText = (label: string, max: number) =>
  z
    .string()
    .trim()
    .min(1, `${label} can’t be empty.`)
    .max(max, `${label} must be ${max} characters or fewer.`);

/** Blank or null → null (the footer hides the icon); otherwise an absolute http(s) URL. */
const socialUrl = (label: string) =>
  z
    .union([z.string(), z.null()])
    .transform((v) => (v == null ? null : v.trim() || null))
    .refine((v) => v === null || v.length <= L.socialUrl, `${label} must be ${L.socialUrl} characters or fewer.`)
    .refine((v) => v === null || isHttpUrl(v), `${label} must start with https:// (or http://).`);

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname.length > 0;
  } catch {
    return false;
  }
}

export const siteSettingsPatchBody = z
  .object({
    tagline: requiredText('Tagline', L.tagline).optional(),
    contactEmail: z
      .string()
      .trim()
      .max(L.contactEmail, `Contact email must be ${L.contactEmail} characters or fewer.`)
      .pipe(z.email('Enter a valid email address.'))
      .optional(),
    aboutStrap: requiredText('About strap', L.aboutStrap).optional(),
    aboutStand: requiredText('About standfirst', L.aboutStand).optional(),
    aboutBodyMd: requiredText('About text', L.aboutBodyMd).optional(),
    socialXUrl: socialUrl('X URL').optional(),
    socialLinkedinUrl: socialUrl('LinkedIn URL').optional(),
  })
  .strict();

export function siteSettingsFrom(row: SiteRow): SiteSettingsDto {
  return {
    tagline: row.tagline,
    contactEmail: row.contactEmail,
    aboutStrap: row.aboutStrap,
    aboutStand: row.aboutStand,
    aboutBodyMd: row.aboutBodyMd,
    socialXUrl: row.socialXUrl ?? null,
    socialLinkedinUrl: row.socialLinkedinUrl ?? null,
  };
}

async function loadRow(siteId: string): Promise<SiteRow> {
  const [row] = await getDb().select().from(site).where(eq(site.id, siteId)).limit(1);
  if (!row) throw new ApiError('NOT_FOUND', 404, 'This site no longer exists — run: pnpm db:seed');
  return row;
}

export async function getSiteSettings(siteId: string): Promise<SiteSettingsDto> {
  return siteSettingsFrom(await loadRow(siteId));
}

/** Applies a validated subset; an empty subset writes nothing. Returns the saved settings. */
export async function updateSiteSettings(
  siteId: string,
  patch: SiteSettingsPatch,
  actor: { userId: string },
): Promise<SiteSettingsDto> {
  const fields = (Object.keys(patch) as Array<keyof SiteSettingsPatch>).filter((k) => patch[k] !== undefined);
  if (fields.length === 0) return getSiteSettings(siteId);

  const set: Partial<SiteSettingsDto> = {};
  for (const k of fields) (set as Record<string, unknown>)[k] = patch[k];

  const [row] = await getDb().update(site).set(set).where(eq(site.id, siteId)).returning();
  if (!row) throw new ApiError('NOT_FOUND', 404, 'This site no longer exists — run: pnpm db:seed');
  invalidateCurrentSite();
  log.info('site.updated', { msg: 'Site settings saved', site_id: siteId, user_id: actor.userId, fields });
  return siteSettingsFrom(row);
}

/**
 * `pnpm db:seed` on a database seeded before the brand became blog0 (divergence 25): sets
 * `wordmark` / `brand_name` from the design's "log0" to the current defaults. Only the legacy
 * value is replaced, so any other value and every admin-edited field are left alone; a second
 * run finds nothing to change and writes nothing.
 */
export async function upgradeLegacyBrand(db: Db, slug: string): Promise<{ updated: boolean }> {
  const [row] = await db
    .select({ id: site.id, wordmark: site.wordmark, brandName: site.brandName })
    .from(site)
    .where(and(eq(site.slug, slug), or(eq(site.wordmark, LEGACY_WORDMARK), eq(site.brandName, LEGACY_WORDMARK))))
    .limit(1);
  if (!row) return { updated: false };

  const set: { wordmark?: string; brandName?: string } = {};
  if (row.wordmark === LEGACY_WORDMARK) set.wordmark = SITE_DEFAULTS.wordmark;
  if (row.brandName === LEGACY_WORDMARK) set.brandName = SITE_DEFAULTS.brandName;
  await db.update(site).set(set).where(eq(site.id, row.id));
  invalidateCurrentSite();
  return { updated: true };
}
