// pnpm backup -- --out <dir> [--storage <dir>]   (capability backup-restore; spec/architecture.md §12.3)
// Backs up BLOG0_DATABASE_URL (postgres:// only; pg_dump custom format from one exported snapshot,
// rate_limit_bucket rows excluded) and the storage dir (--storage, else BLOG0_STORAGE_DIR, else
// ./var/storage) into <out>/blog0-<yyyymmddTHHMMSSZ>/ {db.dump, storage.tar.gz, manifest.json}.
// The last stdout line is the backup dir. Exit 0 ok, 1 failure, 2 usage error / pglite target.
// Stage A: BLOG0_HEARTBEAT_BACKUP_URL (optional) gets GET <url> after a successful backup and
// GET <url>/fail after a failed one (5 s timeout; never changes the exit code; a usage error pings
// nothing) — the dead-man's switch for the scheduled backup (docs/deploy.md → Heartbeats).
import './lib/allow-server-only';

import { loadEnvConfig } from '@next/env';

import { CONFIG_DEFAULTS, HEARTBEAT_ENV } from '../src/server/config';
import { BACKUP_USAGE, BackupUsageError, parseBackupArgs } from '../src/server/ops/backup-manifest';
import { createBackup } from '../src/server/ops/backup';
import { pingHeartbeatFromEnv } from '../src/server/ops/heartbeat';
import { maskSecrets, urlPassword } from '../src/server/ops/pg-tools';

/** Prints every line but holds back the latest, so the backup dir can stay the LAST stdout line. */
function heldOutput(): { out: (line: string) => void; flush: () => void } {
  let held: string | null = null;
  return {
    out: (line) => {
      if (held !== null) console.log(held);
      held = line;
    },
    flush: () => {
      if (held !== null) console.log(held);
      held = null;
    },
  };
}

async function main(): Promise<void> {
  const args = parseBackupArgs(process.argv.slice(2));
  if (args.help) {
    console.log(BACKUP_USAGE);
    return;
  }
  loadEnvConfig(process.cwd(), false, { info: () => {}, error: console.error });
  const envStorage = (process.env.BLOG0_STORAGE_DIR ?? '').replace(/\s+#.*$/, '').trim();
  const output = heldOutput();
  try {
    await createBackup({
      databaseUrl: process.env.BLOG0_DATABASE_URL,
      outDir: args.outDir,
      storageDir: args.storageDir ?? (envStorage || CONFIG_DEFAULTS.storageDir),
      out: output.out,
    });
  } catch (error) {
    output.flush();
    if (!(error instanceof BackupUsageError)) {
      await pingHeartbeatFromEnv({ job: 'backup', env: process.env, name: HEARTBEAT_ENV.backup, signal: 'fail' });
    }
    throw error;
  }
  await pingHeartbeatFromEnv({ job: 'backup', env: process.env, name: HEARTBEAT_ENV.backup, signal: 'success' });
  output.flush();
}

main().catch((error: unknown) => {
  const password = urlPassword((process.env.BLOG0_DATABASE_URL ?? '').trim());
  const message = error instanceof Error ? error.message : String(error);
  console.error(`backup failed: ${maskSecrets(message, password ? [password] : [])}`);
  process.exit(error instanceof BackupUsageError ? 2 : 1);
});
