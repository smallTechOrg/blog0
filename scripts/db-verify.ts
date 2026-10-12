// pnpm db:verify — prints "<db> @ PostgreSQL <v> — N applied (latest <tag>), M pending: OK"; exit 1 if pending.
import './lib/allow-server-only';

import { loadEnvConfig } from '@next/env';

import { loadDatabaseUrl } from '../src/server/config';
import { getMigrationStatus } from '../src/server/db/migrate';

async function main(): Promise<void> {
  loadEnvConfig(process.cwd(), false, { info: () => {}, error: console.error });
  const url = loadDatabaseUrl(process.env);
  const s = await getMigrationStatus(url);
  const ok = s.pending.length === 0;
  const line =
    `${s.database} @ PostgreSQL ${s.serverVersion} — ${s.applied.length} applied ` +
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
