import 'server-only';

import { eq } from 'drizzle-orm';

import type { Db } from '../db/client';
import { site, type SiteRow } from '../db/schema';
import { siteSeedFor } from '../site/defaults';
import { upgradeLegacyBrand } from '../site/service';

// `pnpm db:seed` step 1: upsert the site row (spec/data.md → Seed data). An existing row is left
// untouched (admins edit it in the desk) except for the one-time brand upgrade: a row still
// carrying the design's "log0" wordmark/brand_name becomes "blog0" (upgradeLegacyBrand only
// rewrites that exact legacy value), so re-running the seed changes nothing. Phase 7: a fresh row
// carries the newsletter settings defaults (siteSeedFor); an existing row keeps what the admin set and
// gets the column defaults from migration 0002_newsletter.

export interface SeedSiteResult {
  site: SiteRow;
  status: 'created' | 'ok';
}

export async function seedSite(db: Db, slug: string): Promise<SeedSiteResult> {
  const [inserted] = await db.insert(site).values(siteSeedFor(slug)).onConflictDoNothing({ target: site.slug }).returning();
  if (inserted) return { site: inserted, status: 'created' };
  await upgradeLegacyBrand(db, slug);
  const [existing] = await db.select().from(site).where(eq(site.slug, slug)).limit(1);
  if (!existing) throw new Error(`Site '${slug}' could not be created or read.`);
  return { site: existing, status: 'ok' };
}
