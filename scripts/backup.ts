// pnpm backup -- --out <dir> [--storage <dir>]   (capability backup-restore; spec/architecture.md §12.3)
// Backs up BLOG0_DATABASE_URL (postgres:// only; pg_dump custom format from one exported snapshot,
// rate_limit_bucket rows excluded) and the storage dir (--storage, else BLOG0_STORAGE_DIR, else
// ./var/storage) into <out>/blog0-<yyyymmddTHHMMSSZ>/ {db.dump, storage.tar.gz, manifest.json}.
// The last stdout line is the backup dir. Exit 0 ok, 1 failure, 2 usage error / pglite target.
import './lib/allow-server-only';

import { loadEnvConfig } from '@next/env';

import { CONFIG_DEFAULTS } from '../src/server/config';
import { BACKUP_USAGE, BackupUsageError, parseBackupArgs } from '../src/server/ops/backup-manifest';
import { createBackup } from '../src/server/ops/backup';
import { maskSecrets, urlPassword } from '../src/server/ops/pg-tools';

async function main(): Promise<void> {
  const args = parseBackupArgs(process.argv.slice(2));
  if (args.help) {
    console.log(BACKUP_USAGE);
    return;
  }
  loadEnvConfig(process.cwd(), false, { info: () => {}, error: console.error });
  const envStorage = (process.env.BLOG0_STORAGE_DIR ?? '').replace(/\s+#.*$/, '').trim();
  await createBackup({
    databaseUrl: process.env.BLOG0_DATABASE_URL,
    outDir: args.outDir,
    storageDir: args.storageDir ?? (envStorage || CONFIG_DEFAULTS.storageDir),
    out: (line) => console.log(line),
  });
}

main().catch((error: unknown) => {
  const password = urlPassword((process.env.BLOG0_DATABASE_URL ?? '').trim());
  const message = error instanceof Error ? error.message : String(error);
  console.error(`backup failed: ${maskSecrets(message, password ? [password] : [])}`);
  process.exit(error instanceof BackupUsageError ? 2 : 1);
});
