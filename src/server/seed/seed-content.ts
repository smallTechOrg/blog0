import 'server-only';

import { count, eq } from 'drizzle-orm';

import type { Db } from '../db/client';
import { article } from '../db/schema';

import { seedPosts } from './seed-posts';
import { formatSeedTldrSummary, seedTldr } from './seed-tldr';

// First-deploy content (GCP deploy, spec/architecture.md §12.7; `node seed-content.mjs` in the image,
// run by deploy/vm/deploy-remote.sh after the release step): when the site has ZERO articles, seed
// the 5 smallTech posts (pnpm db:seed:posts) and publish their committed Jev deck fixtures
// (pnpm seed:tldr -- --source fixture) — 0 AI calls, never a per-view call. A site with any article
// (seeded earlier, or a writer's own) is left untouched, so re-deploys are a no-op and a writer who
// deletes the seed posts never gets them back.
//
// `db` must be the app's handle (initDb()/getDb()): the deck path reuses services that read getDb().

export interface SeedContentResult {
  /** Articles the site had before this run (> 0 ⇒ skipped). */
  existingArticles: number;
  skipped: boolean;
  postsCreated: string[];
  decksSeeded: string[];
  /** Warnings from the deck step (e.g. an unmatched fixture line). */
  warnings: string[];
  /** Always 0 (fixture source); kept so the summary line is the same as pnpm seed:tldr's. */
  calls: number;
}

export async function seedContent(db: Db, siteId: string, userId: string): Promise<SeedContentResult> {
  const [{ n }] = await db.select({ n: count() }).from(article).where(eq(article.siteId, siteId));
  const existingArticles = Number(n);
  if (existingArticles > 0) {
    return { existingArticles, skipped: true, postsCreated: [], decksSeeded: [], warnings: [], calls: 0 };
  }
  const posts = await seedPosts(db, siteId, userId);
  const decks = await seedTldr(db, siteId, userId, { source: 'fixture' });
  return {
    existingArticles,
    skipped: false,
    postsCreated: posts.created,
    decksSeeded: decks.seeded,
    warnings: decks.warnings,
    calls: decks.calls,
  };
}

/** One line: what `node seed-content.mjs` prints. */
export function formatSeedContentSummary(slug: string, r: SeedContentResult): string {
  if (r.skipped) return `seed-content: site ${slug} already has ${r.existingArticles} article(s) — skipped (first deploy only)`;
  return `seed-content: site ${slug} — ${r.postsCreated.length} posts created; ${formatSeedTldrSummary({ seeded: r.decksSeeded, calls: r.calls, costUsd: null })}`;
}
