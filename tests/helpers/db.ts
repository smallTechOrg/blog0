// Test database helpers. prepareTestDatabase(): create blog0_test if missing, drop + recreate the
// schema, migrate (run once per test run by the Vitest and Playwright global setups).
// resetDb(): truncate every table and seed the site row (call in beforeEach).
import { sql as dsql } from 'drizzle-orm';
import postgres from 'postgres';

import { getDb } from '@/server/db/client';
import { runMigrations } from '@/server/db/migrate';
import { ensurePostgresDatabase } from '@/server/db/postgres';
import { ALL_TABLE_NAMES, site, type SiteRow } from '@/server/db/schema';
import { siteSeedFor } from '@/server/site/defaults';
import { resetCurrentSiteForTests } from '@/server/site/current';

export async function prepareTestDatabase(testUrl: string): Promise<void> {
  await ensurePostgresDatabase(testUrl);
  const db = postgres(testUrl, { max: 1, connect_timeout: 5, onnotice: () => {} });
  try {
    await db.unsafe('drop schema if exists drizzle cascade; drop schema if exists public cascade; create schema public;');
  } finally {
    await db.end({ timeout: 5 });
  }
  await runMigrations(testUrl);
}

/** Truncates every table and inserts the site row (SITE_DEFAULTS with BLOG0_SITE_SLUG). */
export async function resetDb(): Promise<SiteRow> {
  const db = getDb();
  await db.execute(dsql.raw(`truncate table ${ALL_TABLE_NAMES.map((t) => `"${t}"`).join(', ')} restart identity cascade`));
  resetCurrentSiteForTests();
  const slug = (process.env.BLOG0_SITE_SLUG ?? '').trim() || 'blog0';
  const [row] = await db.insert(site).values(siteSeedFor(slug)).returning();
  return row;
}
