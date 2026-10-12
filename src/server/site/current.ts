import 'server-only';

import { eq } from 'drizzle-orm';

import { getConfig } from '../config';
import { getDb } from '../db/client';
import { site, type SiteRow } from '../db/schema';

// Resolves the site this process serves (BLOG0_SITE_SLUG). Every query filters by its id.
// Cached for SITE_CACHE_MS; Phase 2's site service calls invalidateCurrentSite() after edits.

const SITE_CACHE_MS = 60_000;

export class SiteNotFoundError extends Error {
  constructor(slug: string) {
    super(`Site '${slug}' not found in the database — run: pnpm db:seed`);
    this.name = 'SiteNotFoundError';
  }
}

let cached: { row: SiteRow; at: number } | null = null;

export async function getCurrentSite(now: number = Date.now()): Promise<SiteRow> {
  const slug = getConfig().siteSlug;
  if (cached && cached.row.slug === slug && now - cached.at < SITE_CACHE_MS) return cached.row;
  const [row] = await getDb().select().from(site).where(eq(site.slug, slug)).limit(1);
  if (!row) throw new SiteNotFoundError(slug);
  cached = { row, at: now };
  return row;
}

export function invalidateCurrentSite(): void {
  cached = null;
}

export function resetCurrentSiteForTests(): void {
  cached = null;
}
