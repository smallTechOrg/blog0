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

// The cache lives on globalThis, not in module scope: `next build` copies this module into
// several server chunks (route handlers and pages each get their own instance), so a module-level
// variable would let PATCH /api/admin/site invalidate only its own copy while the pages kept
// serving the old About text for up to SITE_CACHE_MS.
const CACHE_KEY = Symbol.for('blog0.currentSiteCache');
type SiteCacheHolder = typeof globalThis & { [CACHE_KEY]?: { row: SiteRow; at: number } | null };
const holder = globalThis as SiteCacheHolder;

export async function getCurrentSite(now: number = Date.now()): Promise<SiteRow> {
  const slug = getConfig().siteSlug;
  const cached = holder[CACHE_KEY];
  if (cached && cached.row.slug === slug && now - cached.at < SITE_CACHE_MS) return cached.row;
  const [row] = await getDb().select().from(site).where(eq(site.slug, slug)).limit(1);
  if (!row) throw new SiteNotFoundError(slug);
  holder[CACHE_KEY] = { row, at: now };
  return row;
}

export function invalidateCurrentSite(): void {
  holder[CACHE_KEY] = null;
}

export function resetCurrentSiteForTests(): void {
  holder[CACHE_KEY] = null;
}
