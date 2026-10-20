// pnpm release (locally, via tsx) | node release.mjs (in the image, bundled by scripts/build-release.mjs)
// The release step: apply pending migrations to BLOG0_DATABASE_URL (postgres:// only), verify 0
// pending, ensure the BLOG0_SITE_SLUG site row and — when BLOG0_ADMIN_EMAIL and BLOG0_ADMIN_PASSWORD
// are both set — the first admin (an existing admin's password is never reset). Idempotent.
// Prints "release: <db> @ PostgreSQL <v> — N applied (latest <tag>), 0 pending: OK" then
// "site <slug> ok…, admin <masked> ok…". Exit 0 ok, 1 failure, 2 misuse (pglite:// target).
// Deliberately does NOT import scripts/lib/cli.ts: that pulls the content pipeline (Shiki) into
// the bundle through seed-posts. The bundle maps the shim below to an empty module.
import './lib/allow-server-only';

import { loadEnvConfig } from '@next/env';

import { ReleaseUsageError, releaseSiteSlug, runRelease } from '../src/server/ops/release';

async function main(): Promise<void> {
  loadEnvConfig(process.cwd(), false, { info: () => {}, error: console.error });
  const slug = releaseSiteSlug(process.env);
  await runRelease({ env: process.env, slug, out: (line) => console.log(line) });
}

main().catch((error: unknown) => {
  console.error(`release failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(error instanceof ReleaseUsageError ? 2 : 1);
});
