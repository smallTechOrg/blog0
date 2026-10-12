// Shared plumbing for the tsx scripts: load .env, run `main`, print `<name> failed: <message>` and
// exit 1 on any error; BLOG0_SITE_SLUG and the site/admin lookups the seeders share.
import './allow-server-only';

import { loadEnvConfig } from '@next/env';
import { eq } from 'drizzle-orm';

import { CONFIG_DEFAULTS } from '../../src/server/config';
import type { Db } from '../../src/server/db/client';
import { site } from '../../src/server/db/schema';
import { firstAdminId } from '../../src/server/seed/seed-posts';

export function runCli(name: string, main: () => Promise<void>): void {
  loadEnvConfig(process.cwd(), false, { info: () => {}, error: console.error });
  main().catch((error: unknown) => {
    console.error(`${name} failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

/** BLOG0_SITE_SLUG (comment-tolerant, default `blog0`), validated. */
export function siteSlugFromEnv(): string {
  const slug = (process.env.BLOG0_SITE_SLUG ?? '').replace(/\s+#.*$/, '').trim() || CONFIG_DEFAULTS.siteSlug;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error('BLOG0_SITE_SLUG must be lowercase words joined by hyphens.');
  return slug;
}

/** The site's id, or an error pointing at `pnpm db:seed`. */
export async function requireSiteId(db: Db, slug: string): Promise<string> {
  const [row] = await db.select({ id: site.id }).from(site).where(eq(site.slug, slug)).limit(1);
  if (!row) throw new Error(`Site '${slug}' not found — run: pnpm db:seed`);
  return row.id;
}

/** The site's first admin (the seed author), or an error pointing at `pnpm db:seed`. */
export async function requireFirstAdmin(db: Db, siteId: string, slug: string): Promise<string> {
  const userId = await firstAdminId(db, siteId);
  if (!userId) throw new Error(`Site '${slug}' has no admin yet — run: pnpm db:seed`);
  return userId;
}
