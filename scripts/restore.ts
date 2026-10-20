// pnpm restore -- --in <backupDir> --db <name|postgres://url> --storage <dir> [--force] [--check-only]
// (capability backup-restore; spec/architecture.md §12.3). Verifies the backup's checksums, restores
// db.dump into the target database (a bare name takes host + credentials from BLOG0_DATABASE_URL;
// created if missing; a non-empty one is refused unless --force) and storage.tar.gz into --storage,
// then prints restore-check (rows/files/bytes vs the manifest). --check-only runs only the check.
// Exit 0 ok, 1 failure or restore-check mismatch, 2 usage error.
import './lib/allow-server-only';

import { loadEnvConfig } from '@next/env';

import { BackupUsageError, parseRestoreArgs, resolveTargetUrl, RESTORE_USAGE } from '../src/server/ops/backup-manifest';
import { maskSecrets, urlPassword } from '../src/server/ops/pg-tools';
import { restoreBackup } from '../src/server/ops/restore';

const secrets: string[] = [];

async function main(): Promise<number> {
  const args = parseRestoreArgs(process.argv.slice(2));
  if (args.help) {
    console.log(RESTORE_USAGE);
    return 0;
  }
  loadEnvConfig(process.cwd(), false, { info: () => {}, error: console.error });
  for (const url of [args.db, process.env.BLOG0_DATABASE_URL ?? '']) {
    const password = urlPassword(url.trim());
    if (password) secrets.push(password);
  }
  const targetUrl = resolveTargetUrl(args.db, process.env.BLOG0_DATABASE_URL);
  const report = await restoreBackup({
    inDir: args.inDir,
    targetUrl,
    storageDir: args.storageDir,
    force: args.force,
    checkOnly: args.checkOnly,
    out: (line) => console.log(maskSecrets(line, secrets)),
  });
  return report.ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`restore failed: ${maskSecrets(message, secrets)}`);
    process.exit(error instanceof BackupUsageError ? 2 : 1);
  },
);
