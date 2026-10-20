// pnpm db:seed:posts — seeds the 5 design articles (src/server/seed/posts/) as published posts into
// the site BLOG0_SITE_SLUG of BLOG0_DATABASE_URL, authored by the site's first admin. Run
// `pnpm db:seed` first. Prints "5 posts: N created". Idempotent by slug: existing slugs (and any
// later writer edits to them) are left untouched, so a second run prints "5 posts: 0 created".
// No AI call happens here (decks are `pnpm seed:tldr`).
import { requireFirstAdmin, requireSiteId, runCli, siteSlugFromEnv } from './lib/cli';

import { loadDatabaseTarget } from '../src/server/config';
import { createDbHandle } from '../src/server/db/client';
import { SEED_POSTS } from '../src/server/seed/posts';
import { seedPosts } from '../src/server/seed/seed-posts';

runCli('db:seed:posts', async () => {
  const unknown = process.argv.slice(2);
  if (unknown.length > 0) throw new Error(`Unknown argument(s): ${unknown.join(' ')} (db:seed:posts takes none)`);
  const target = loadDatabaseTarget(process.env);
  const slug = siteSlugFromEnv();

  // postgres:// or pglite://<dir> (spec/architecture.md §11.2) — everything below only uses the Drizzle `db`.
  const handle = await createDbHandle(target, { max: 1 });
  try {
    const siteId = await requireSiteId(handle.db, slug);
    const result = await seedPosts(handle.db, siteId, await requireFirstAdmin(handle.db, siteId, slug));
    console.log(`${SEED_POSTS.length} posts: ${result.created.length} created`);
  } finally {
    await handle.close();
  }
});
