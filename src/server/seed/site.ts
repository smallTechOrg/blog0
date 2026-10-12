import 'server-only';

import { eq } from 'drizzle-orm';

import type { Db } from '../db/client';
import { site, type SiteRow } from '../db/schema';
import { siteSeedFor } from '../site/defaults';

// `pnpm db:seed` step 1: upsert the site row (spec/data.md → Seed data). An existing row is left
// untouched (admins edit it from Phase 2), so re-running the seed changes nothing.

export interface SeedSiteResult {
  site: SiteRow;
  status: 'created' | 'ok';
}

export async function seedSite(db: Db, slug: string): Promise<SeedSiteResult> {
  const [inserted] = await db.insert(site).values(siteSeedFor(slug)).onConflictDoNothing({ target: site.slug }).returning();
  if (inserted) return { site: inserted, status: 'created' };
  const [existing] = await db.select().from(site).where(eq(site.slug, slug)).limit(1);
  if (!existing) throw new Error(`Site '${slug}' could not be created or read.`);
  return { site: existing, status: 'ok' };
}
