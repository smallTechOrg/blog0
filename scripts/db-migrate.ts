// pnpm db:migrate — applies pending migrations (src/server/db/migrations) to BLOG0_DATABASE_URL
// (postgres://…, or pglite://<dir> for designer mode; never while a dev server has that dir open).
import './lib/allow-server-only';

import { loadEnvConfig } from '@next/env';

import { loadDatabaseTarget } from '../src/server/config';
import { createDbHandle } from '../src/server/db/client';
import { getMigrationStatus, runMigrations } from '../src/server/db/migrate';
import { describeDatabase } from '../src/server/db/url';

async function main(): Promise<void> {
  loadEnvConfig(process.cwd(), false, { info: () => {}, error: console.error });
  const target = loadDatabaseTarget(process.env);
  const label = describeDatabase(target);
  const handle = await createDbHandle(target, { max: 1 });
  try {
    const applied = await runMigrations(handle);
    const status = await getMigrationStatus(handle);
    if (applied.length === 0) {
      console.log(`${label}: already up to date (latest ${status.latestApplied ?? 'none'})`);
    } else {
      for (const tag of applied) console.log(`${label}: applied ${tag}`);
    }
    if (status.pending.length > 0) {
      throw new Error(`${status.pending.length} migration(s) still pending: ${status.pending.join(', ')}`);
    }
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  console.error(`db:migrate failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
