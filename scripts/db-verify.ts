// pnpm db:verify — prints "<db> @ PostgreSQL <v> — N applied (latest <tag>), M pending: OK"; exit 1 if pending.
// On pglite:// the label is "pglite:<dir> @ PostgreSQL 17.x (PGlite) — …" (PGlite reports a plain
// server_version and current_database() = template1, so both are composed from the engine).
import { runCli } from './lib/cli';

import { loadDatabaseTarget } from '../src/server/config';
import { getMigrationStatus } from '../src/server/db/migrate';
import { describeDatabase } from '../src/server/db/url';

runCli('db:verify', async () => {
  const target = loadDatabaseTarget(process.env);
  const s = await getMigrationStatus(target);
  const ok = s.pending.length === 0;
  const name = target.engine === 'pglite' ? describeDatabase(target) : s.database;
  const version = target.engine === 'pglite' ? `${s.serverVersion} (PGlite)` : s.serverVersion;
  console.log(
    `${name} @ PostgreSQL ${version} — ${s.applied.length} applied ` +
      `(latest ${s.latestApplied ?? 'none'}), ${s.pending.length} pending: ${ok ? 'OK' : 'PENDING'}`,
  );
  if (!ok) {
    console.error(`pending: ${s.pending.join(', ')} — run: pnpm db:migrate`);
    process.exit(1);
  }
});
