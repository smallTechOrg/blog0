// pnpm db:migrate — applies pending migrations (src/server/db/migrations) to BLOG0_DATABASE_URL.
import './lib/allow-server-only';

import { loadEnvConfig } from '@next/env';

import { loadDatabaseUrl } from '../src/server/config';
import { getMigrationStatus, runMigrations } from '../src/server/db/migrate';

async function main(): Promise<void> {
  loadEnvConfig(process.cwd(), false, { info: () => {}, error: console.error });
  const url = loadDatabaseUrl(process.env);
  const applied = await runMigrations(url);
  const status = await getMigrationStatus(url);
  if (applied.length === 0) {
    console.log(`${status.database}: already up to date (latest ${status.latestApplied ?? 'none'})`);
  } else {
    for (const tag of applied) console.log(`${status.database}: applied ${tag}`);
  }
  if (status.pending.length > 0) {
    throw new Error(`${status.pending.length} migration(s) still pending: ${status.pending.join(', ')}`);
  }
}

main().catch((error: unknown) => {
  console.error(`db:migrate failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
