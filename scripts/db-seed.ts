// pnpm db:seed [--reset-admin-password] — upserts the site row (BLOG0_SITE_SLUG) and the first admin
// (BLOG0_ADMIN_EMAIL / BLOG0_ADMIN_PASSWORD / BLOG0_ADMIN_NAME) into BLOG0_DATABASE_URL
// (postgres:// or pglite://<dir>; designer mode seeds its own admin via `pnpm dev:design`).
// Prints e.g. "site blog0 ok, admin s***@smalltech.in ok" (email masked; the password is never printed).
// Idempotent: an existing site/admin is left untouched (the password only changes with the flag).
import './lib/allow-server-only';

import { loadEnvConfig } from '@next/env';

import { CONFIG_DEFAULTS, loadDatabaseTarget } from '../src/server/config';
import { createDbHandle } from '../src/server/db/client';
import { maskEmail } from '../src/server/log';
import { adminCredentialsFromEnv, seedAdmin, SeedError } from '../src/server/seed/admin';
import { seedSite } from '../src/server/seed/site';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function siteSlugFromEnv(): string {
  const slug = (process.env.BLOG0_SITE_SLUG ?? '').replace(/\s+#.*$/, '').trim() || CONFIG_DEFAULTS.siteSlug;
  if (!SLUG_RE.test(slug)) throw new SeedError('BLOG0_SITE_SLUG must be lowercase words joined by hyphens.');
  return slug;
}

function describe(status: 'created' | 'ok' | 'password_reset'): string {
  if (status === 'created') return 'ok (created)';
  if (status === 'password_reset') return 'ok (password reset)';
  return 'ok';
}

async function main(): Promise<void> {
  loadEnvConfig(process.cwd(), false, { info: () => {}, error: console.error });
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== '--reset-admin-password');
  if (unknown.length > 0) throw new SeedError(`Unknown argument(s): ${unknown.join(' ')} (only --reset-admin-password is accepted)`);
  const resetPassword = args.includes('--reset-admin-password');

  // Validate everything before touching the database.
  const target = loadDatabaseTarget(process.env);
  const slug = siteSlugFromEnv();
  const credentials = adminCredentialsFromEnv(process.env);

  const handle = await createDbHandle(target, { max: 1 });
  try {
    const { db } = handle;
    const siteResult = await seedSite(db, slug);
    const adminResult = await seedAdmin(db, siteResult.site.id, credentials, { resetPassword });
    console.log(`site ${slug} ${describe(siteResult.status)}, admin ${maskEmail(adminResult.email)} ${describe(adminResult.status)}`);
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  console.error(`db:seed failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
