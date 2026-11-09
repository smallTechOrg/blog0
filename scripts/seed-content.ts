// node seed-content.mjs (in the image; bundled by scripts/build-release.mjs) | tsx scripts/seed-content.ts
// First-deploy content seed (GCP deploy, spec/architecture.md §12.7): ONLY when the site
// BLOG0_SITE_SLUG of BLOG0_DATABASE_URL has zero articles — the 5 smallTech posts + their committed
// Jev deck fixtures (0 AI calls). Needs the release step first (site + first admin). Prints
// "seed-content: site <slug> — 5 posts created; decks: 5 seeded (0 calls)" or
// "seed-content: site <slug> already has N article(s) — skipped (first deploy only)".
// Exit 0 ok (also when skipped), 1 failure, 2 usage. Uses the scripts/release.ts runner pattern.
import './lib/allow-server-only';

import { loadEnvConfig } from '@next/env';

import { requireFirstAdmin, requireSiteId, siteSlugFromEnv } from './lib/cli';

import { closeDb, initDb } from '../src/server/db/client';
import { formatSeedContentSummary, seedContent } from '../src/server/seed/seed-content';

class UsageError extends Error {}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  if (args.length > 0) throw new UsageError(`Unknown argument(s): ${args.join(' ')} (seed-content takes none)`);
  loadEnvConfig(process.cwd(), false, { info: () => {}, error: console.error });
  const slug = siteSlugFromEnv();
  const { db } = await initDb();
  try {
    const siteId = await requireSiteId(db, slug);
    const userId = await requireFirstAdmin(db, siteId, slug);
    const result = await seedContent(db, siteId, userId);
    for (const warning of result.warnings) console.warn(`warning: ${warning}`);
    console.log(formatSeedContentSummary(slug, result));
  } finally {
    await closeDb();
  }
}

main().catch((error: unknown) => {
  console.error(`seed-content failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(error instanceof UsageError ? 2 : 1);
});
