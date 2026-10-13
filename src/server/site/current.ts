import 'server-only';

import { eq } from 'drizzle-orm';

import { getConfig } from '../config';
import { getDb } from '../db/client';
import { site, type SiteRow } from '../db/schema';

// Resolves the site this process serves (BLOG0_SITE_SLUG). Every query filters by its id.
// Cached for SITE_CACHE_MS; the site service calls invalidateCurrentSite() after edits.

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
// `generation` is bumped on every invalidation: a read captures it before its SELECT and stores the
// row only if no invalidation happened meanwhile, so a read that started before a site save can never
// re-store the pre-save row after invalidateCurrentSite().
const CACHE_KEY = Symbol.for('blog0.currentSiteCache');
interface SiteCache {
  entry: { row: SiteRow; at: number } | null;
  generation: number;
}
type SiteCacheHolder = typeof globalThis & { [CACHE_KEY]?: SiteCache };
const holder = globalThis as SiteCacheHolder;

function cache(): SiteCache {
  return (holder[CACHE_KEY] ??= { entry: null, generation: 0 });
}

export async function getCurrentSite(now: number = Date.now()): Promise<SiteRow> {
  const slug = getConfig().siteSlug;
  const state = cache();
  const cached = state.entry;
  if (cached && cached.row.slug === slug && now - cached.at < SITE_CACHE_MS) return cached.row;
  const generation = state.generation;
  const [row] = await getDb().select().from(site).where(eq(site.slug, slug)).limit(1);
  if (!row) throw new SiteNotFoundError(slug);
  if (state.generation === generation) state.entry = { row, at: now };
  return row;
}

export function invalidateCurrentSite(): void {
  const state = cache();
  state.entry = null;
  state.generation += 1;
}

export function resetCurrentSiteForTests(): void {
  invalidateCurrentSite();
}
