// pnpm db:seed:posts — seeds the 5 design articles (src/server/seed/posts/) as published posts into
// the site BLOG0_SITE_SLUG of BLOG0_DATABASE_URL, authored by the site's first admin. Run
// `pnpm db:seed` first. Prints "5 posts: N created". Idempotent by slug: existing slugs (and any
// later writer edits to them) are left untouched, so a second run prints "5 posts: 0 created".
// No AI call happens here (decks are `pnpm seed:tldr`).
import './lib/allow-server-only';

import { loadEnvConfig } from '@next/env';
import { eq } from 'drizzle-orm';

import { CONFIG_DEFAULTS, loadDatabaseTarget } from '../src/server/config';
import { createDbHandle } from '../src/server/db/client';
import { site } from '../src/server/db/schema';
import { SEED_POSTS } from '../src/server/seed/posts';
import { firstAdminId, SeedPostsError, seedPosts } from '../src/server/seed/seed-posts';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function siteSlugFromEnv(): string {
  const slug = (process.env.BLOG0_SITE_SLUG ?? '').replace(/\s+#.*$/, '').trim() || CONFIG_DEFAULTS.siteSlug;
  if (!SLUG_RE.test(slug)) throw new SeedPostsError('BLOG0_SITE_SLUG must be lowercase words joined by hyphens.');
  return slug;
}

async function main(): Promise<void> {
  loadEnvConfig(process.cwd(), false, { info: () => {}, error: console.error });
  const unknown = process.argv.slice(2);
  if (unknown.length > 0) throw new SeedPostsError(`Unknown argument(s): ${unknown.join(' ')} (db:seed:posts takes none)`);

  const target = loadDatabaseTarget(process.env);
  const slug = siteSlugFromEnv();

  // postgres:// or pglite://<dir> (spec/architecture.md §11.2) — everything below only uses the Drizzle `db`.
  const handle = await createDbHandle(target, { max: 1 });
  try {
    const [siteRow] = await handle.db.select({ id: site.id }).from(site).where(eq(site.slug, slug)).limit(1);
    if (!siteRow) throw new SeedPostsError(`Site '${slug}' not found — run: pnpm db:seed`);
    const userId = await firstAdminId(handle.db, siteRow.id);
    if (!userId) throw new SeedPostsError(`Site '${slug}' has no admin yet — run: pnpm db:seed`);

    const result = await seedPosts(handle.db, siteRow.id, userId);
    console.log(`${SEED_POSTS.length} posts: ${result.created.length} created`);
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  console.error(`db:seed:posts failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
