// pnpm seed:tldr [-- --write-fixture] [-- --source auto|jev|fixture]
// Seeds one published TLDR deck per seeded post (pnpm db:seed:posts) that has none, in the site
// BLOG0_SITE_SLUG of BLOG0_DATABASE_URL, as the site's first admin (spec/data.md → Seed data):
//   - with a real OpenRouter key: one real Jev call per post (≈5 calls once, recorded in the cost
//     ledger like a writer's Generate), then Publish;
//   - without one (designer mode): the committed fixture src/server/seed/decks/<slug>.json, 0 calls.
// Prints "decks: N seeded (N calls, $…)". Idempotent: a second run prints "decks: 0 seeded (0 calls)".
// --write-fixture (real key): afterwards rewrite each <slug>.json from the post's published Jev deck.
import './lib/allow-server-only';

import { loadEnvConfig } from '@next/env';
import { eq } from 'drizzle-orm';

import { getConfig } from '../src/server/config';
import { closeDb, initDb } from '../src/server/db/client';
import { site } from '../src/server/db/schema';
import { firstAdminId } from '../src/server/seed/seed-posts';
import { formatSeedTldrSummary, SeedTldrError, seedTldr, type SeedTldrSource } from '../src/server/seed/seed-tldr';

const USAGE = 'Usage: pnpm seed:tldr [-- --write-fixture] [-- --source auto|jev|fixture]';
const SOURCES: readonly SeedTldrSource[] = ['auto', 'jev', 'fixture'];

function parseArgs(argv: string[]): { writeFixture: boolean; source: SeedTldrSource } {
  const out = { writeFixture: false, source: 'auto' as SeedTldrSource };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--write-fixture') {
      out.writeFixture = true;
    } else if (arg === '--source' || arg.startsWith('--source=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[(i += 1)];
      if (!SOURCES.includes(value as SeedTldrSource)) throw new SeedTldrError(`--source must be one of ${SOURCES.join(', ')}.\n${USAGE}`);
      out.source = value as SeedTldrSource;
    } else {
      throw new SeedTldrError(`Unknown argument: ${arg}\n${USAGE}`);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  loadEnvConfig(process.cwd(), false, { info: () => {}, error: console.error });
  const config = getConfig();

  // The app's own handle: generateTldr/saveDeck/publishArticle use getDb(), so this run must too
  // (on PGlite a second instance on the same directory is never opened).
  const { db } = await initDb();
  try {
    const [siteRow] = await db.select({ id: site.id }).from(site).where(eq(site.slug, config.siteSlug)).limit(1);
    if (!siteRow) throw new SeedTldrError(`Site '${config.siteSlug}' not found — run: pnpm db:seed`);
    const userId = await firstAdminId(db, siteRow.id);
    if (!userId) throw new SeedTldrError(`Site '${config.siteSlug}' has no admin yet — run: pnpm db:seed`);

    const result = await seedTldr(db, siteRow.id, userId, { source: args.source, writeFixture: args.writeFixture });
    console.log(`source: ${result.source === 'jev' ? 'Jev (real OpenRouter key)' : 'committed fixture (src/server/seed/decks)'}`);
    for (const warning of result.warnings) console.warn(`warning: ${warning}`);
    if (result.skipped.length > 0) console.log(`already published (untouched): ${result.skipped.join(', ')}`);
    for (const file of result.fixturesWritten) console.log(`fixture written: ${file}`);
    console.log(formatSeedTldrSummary(result));
  } finally {
    await closeDb();
  }
}

main().catch((error: unknown) => {
  console.error(`seed:tldr failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
