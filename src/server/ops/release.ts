import 'server-only';

import postgres from 'postgres';

import { CONFIG_DEFAULTS, loadDatabaseTarget } from '../config';
import { createDbHandle } from '../db/client';
import { getMigrationStatus, runMigrations } from '../db/migrate';
import { describeDatabase } from '../db/url';
import { maskEmail } from '../log';
import { adminCredentialsFromEnv, seedAdmin } from '../seed/admin';
import { seedSite } from '../seed/site';

import { appRoleFromEnv, ensureAppRole } from './app-role';

// The release step (capability container-image; spec/architecture.md §12.1): apply pending
// migrations → verify 0 pending → ensure the site row → ensure the first admin when BLOG0_ADMIN_*
// is set (never resets an existing password). Idempotent. Postgres only — designer mode (PGlite)
// migrates in `pnpm dev:design`. Run as `pnpm release` locally and `node release.mjs` in the image
// (scripts/release.ts, bundled by scripts/build-release.mjs). Never prints a password or a URL.
// GCP deploy (spec/architecture.md §12.7): with BLOG0_APP_DB_ROLE + BLOG0_APP_DB_PASSWORD set, the
// release (connected as the schema owner) also ensures that restricted runtime role after the
// migrations (src/server/ops/app-role.ts) and prints "app role <name> ok (created|updated)".

/** A misuse (pglite target) rather than a failure: the CLI exits 2. */
export class ReleaseUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReleaseUsageError';
  }
}

type Env = Record<string, string | undefined>;

const DESCRIBE = { created: 'ok (created)', password_reset: 'ok (password reset)', ok: 'ok' } as const;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** BLOG0_SITE_SLUG (comment-tolerant, default `blog0`) — the same rule as the tsx scripts' siteSlugFromEnv. */
export function releaseSiteSlug(env: Env): string {
  const slug = (env.BLOG0_SITE_SLUG ?? '').replace(/\s+#.*$/, '').trim() || CONFIG_DEFAULTS.siteSlug;
  if (!SLUG_RE.test(slug)) throw new Error('BLOG0_SITE_SLUG must be lowercase words joined by hyphens.');
  return slug;
}

const present = (value: string | undefined): boolean => (value ?? '').replace(/\s+#.*$/, '').trim() !== '';

export async function runRelease({ env, slug, out }: { env: Env; slug: string; out: (line: string) => void }): Promise<void> {
  // Validate everything before touching the database.
  const target = loadDatabaseTarget(env);
  if (target.engine !== 'postgres') {
    throw new ReleaseUsageError('the release step is for Postgres; designer mode migrates in pnpm dev:design');
  }
  const credentials =
    present(env.BLOG0_ADMIN_EMAIL) && present(env.BLOG0_ADMIN_PASSWORD) ? adminCredentialsFromEnv(env) : null;
  const appRole = appRoleFromEnv(env);
  const label = describeDatabase(target);

  const handle = await createDbHandle(target, { max: 1 });
  try {
    const applied = await runMigrations(handle);
    const status = await getMigrationStatus(handle);
    if (applied.length === 0) out(`${label}: already up to date (latest ${status.latestApplied ?? 'none'})`);
    else for (const tag of applied) out(`${label}: applied ${tag}`);
    if (status.pending.length > 0) {
      throw new Error(`${status.pending.length} migration(s) still pending: ${status.pending.join(', ')}`);
    }
    out(
      `release: ${status.database} @ PostgreSQL ${status.serverVersion} — ${status.applied.length} applied ` +
        `(latest ${status.latestApplied ?? 'none'}), 0 pending: OK`,
    );

    if (appRole) {
      const sql = postgres(target.url, { max: 1, connect_timeout: 10, onnotice: () => {} });
      try {
        const roleStatus = await ensureAppRole(sql, appRole);
        out(`app role ${appRole.role} ok (${roleStatus})`);
      } finally {
        await sql.end({ timeout: 5 });
      }
    }

    const siteResult = await seedSite(handle.db, slug);
    let adminPart = 'admin skipped (BLOG0_ADMIN_* not set)';
    if (credentials) {
      const adminResult = await seedAdmin(handle.db, siteResult.site.id, credentials, { resetPassword: false });
      adminPart = `admin ${maskEmail(adminResult.email)} ${DESCRIBE[adminResult.status]}`;
    }
    out(`site ${slug} ${DESCRIBE[siteResult.status]}, ${adminPart}`);
  } finally {
    await handle.close();
  }
}
