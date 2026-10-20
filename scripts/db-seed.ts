// pnpm db:seed [--reset-admin-password] — upserts the site row (BLOG0_SITE_SLUG) and the first admin
// (BLOG0_ADMIN_EMAIL / BLOG0_ADMIN_PASSWORD / BLOG0_ADMIN_NAME) into BLOG0_DATABASE_URL
// (postgres:// or pglite://<dir>; designer mode seeds its own admin via `pnpm dev:design`).
// Prints e.g. "site blog0 ok, admin s***@smalltech.in ok" (email masked; the password is never printed).
// Idempotent: an existing site/admin is left untouched (the password only changes with the flag).
import { runCli, siteSlugFromEnv } from './lib/cli';

import { loadDatabaseTarget } from '../src/server/config';
import { createDbHandle } from '../src/server/db/client';
import { maskEmail } from '../src/server/log';
import { adminCredentialsFromEnv, seedAdmin, SeedError } from '../src/server/seed/admin';
import { seedSite } from '../src/server/seed/site';

const DESCRIBE = { created: 'ok (created)', password_reset: 'ok (password reset)', ok: 'ok' } as const;

runCli('db:seed', async () => {
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
    const siteResult = await seedSite(handle.db, slug);
    const adminResult = await seedAdmin(handle.db, siteResult.site.id, credentials, { resetPassword });
    console.log(`site ${slug} ${DESCRIBE[siteResult.status]}, admin ${maskEmail(adminResult.email)} ${DESCRIBE[adminResult.status]}`);
  } finally {
    await handle.close();
  }
});
