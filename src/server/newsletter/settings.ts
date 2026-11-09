import 'server-only';

import { eq } from 'drizzle-orm';

import type { NewsletterSettingsDto } from '@/lib/api/dto';

import { getDb } from '../db/client';
import { site, type SiteRow } from '../db/schema';
import { ApiError } from '../http/api';
import { log } from '../log';
import { invalidateCurrentSite } from '../site/current';

import type { SettingsPatchInput } from './schemas';

// Site → Newsletter settings (spec/data.md `site.newsletter_*`; spec/api.md PATCH
// /api/admin/newsletter/settings — the route itself is slice S7.3's; it calls these). Changing the
// mode stamps `modeSetAt`; changing the consent text without a version bumps the version.

export function newsletterSettingsFrom(row: SiteRow): NewsletterSettingsDto {
  return {
    mode: row.newsletterMode,
    autoSend: row.newsletterAutoSend,
    digestDays: row.newsletterDigestDays,
    digestPosts: row.newsletterDigestPosts,
    consentText: row.newsletterConsentText,
    consentVersion: row.newsletterConsentVersion,
    modeSetAt: row.newsletterModeSetAt ? row.newsletterModeSetAt.toISOString() : null,
  };
}

/** `v1` → `v2`; a non-`vN` version gets `-2` appended (spec/api.md PATCH …/newsletter/settings). */
export function bumpConsentVersion(version: string): string {
  const v = /^v(\d+)$/.exec(version);
  if (v) return `v${Number(v[1]) + 1}`;
  return `${version}-2`;
}

export async function updateNewsletterSettings(siteId: string, patch: SettingsPatchInput, actor: { userId: string }, now = new Date()): Promise<NewsletterSettingsDto> {
  const db = getDb();
  const [row] = await db.select().from(site).where(eq(site.id, siteId)).limit(1);
  if (!row) throw new ApiError('NOT_FOUND', 404, 'This site no longer exists — run: pnpm db:seed');

  const set: Partial<typeof site.$inferInsert> = {};
  if (patch.mode !== undefined && patch.mode !== row.newsletterMode) {
    set.newsletterMode = patch.mode;
    set.newsletterModeSetAt = now;
  }
  if (patch.autoSend !== undefined) set.newsletterAutoSend = patch.autoSend;
  if (patch.digestDays !== undefined) set.newsletterDigestDays = patch.digestDays;
  if (patch.digestPosts !== undefined) set.newsletterDigestPosts = patch.digestPosts;
  const consentText = patch.consentText?.trim();
  const consentVersion = patch.consentVersion?.trim();
  if (consentText !== undefined && consentText !== '' && consentText !== row.newsletterConsentText) {
    set.newsletterConsentText = consentText;
    set.newsletterConsentVersion = consentVersion || bumpConsentVersion(row.newsletterConsentVersion);
  } else if (consentVersion) {
    set.newsletterConsentVersion = consentVersion;
  }
  if (Object.keys(set).length === 0) return newsletterSettingsFrom(row);

  const [saved] = await db.update(site).set(set).where(eq(site.id, siteId)).returning();
  invalidateCurrentSite();
  log.info('site.updated', { msg: 'Newsletter settings saved', site_id: siteId, user_id: actor.userId, fields: Object.keys(set) });
  return newsletterSettingsFrom(saved);
}
