// pnpm db:verify — prints "<db> @ PostgreSQL <v> — N applied (latest <tag>), M pending: OK"; exit 1 if pending.
// On pglite:// the label is "pglite:<dir> @ PostgreSQL 17.x (PGlite) — …" (PGlite reports a plain
// server_version and current_database() = template1, so both are composed from the engine).
import './lib/allow-server-only';

import { loadEnvConfig } from '@next/env';

import { loadDatabaseTarget } from '../src/server/config';
import { getMigrationStatus } from '../src/server/db/migrate';
import { describeDatabase } from '../src/server/db/url';

async function main(): Promise<void> {
  loadEnvConfig(process.cwd(), false, { info: () => {}, error: console.error });
  const target = loadDatabaseTarget(process.env);
  const s = await getMigrationStatus(target);
  const ok = s.pending.length === 0;
  const name = target.engine === 'pglite' ? describeDatabase(target) : s.database;
  const version = target.engine === 'pglite' ? `${s.serverVersion} (PGlite)` : s.serverVersion;
  const line =
    `${name} @ PostgreSQL ${version} — ${s.applied.length} applied ` +
    `(latest ${s.latestApplied ?? 'none'}), ${s.pending.length} pending: ${ok ? 'OK' : 'PENDING'}`;
  console.log(line);
  if (!ok) {
    console.error(`pending: ${s.pending.join(', ')} — run: pnpm db:migrate`);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(`db:verify failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
