// Backup manifest + restore-check comparison + CLI flag parsing for `pnpm backup` / `pnpm restore`
// (capability backup-restore; spec/architecture.md §12.3). Pure: no I/O, no `server-only` — the
// unit tests and the tsx scripts import it directly.
import { parseArgs } from 'node:util';

import { z } from 'zod';

import { ALL_TABLE_NAMES } from '../db/schema';

export const BACKUP_FORMAT = 'blog0-backup/1';
export const MANIFEST_FILE = 'manifest.json';
export const DUMP_FILE = 'db.dump';
export const ARCHIVE_FILE = 'storage.tar.gz';

/** Tables whose schema is dumped but whose rows are not (ephemeral throttle windows). */
export const EXCLUDED_DATA_TABLES = ['rate_limit_bucket'] as const;

/** Every table whose rows the backup carries, parents first (site → … → media_asset). */
export const BACKUP_TABLES: readonly string[] = [...ALL_TABLE_NAMES]
  .reverse()
  .filter((t) => !(EXCLUDED_DATA_TABLES as readonly string[]).includes(t));

/** A failure: the CLIs print `<name> failed: <message>` and exit 1. */
export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

/** A misuse (unknown/missing flag, pglite target): the CLIs exit 2. */
export class BackupUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupUsageError';
  }
}

export const PGLITE_NOT_SUPPORTED =
  'backups cover Postgres only — designer data lives in the PGlite directory; copy it while dev:design is stopped';

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'must be a sha256 hex digest');
const count = z.number().int().nonnegative();

export const backupManifestSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  createdAt: z.iso.datetime(),
  appVersion: z.string(),
  database: z.object({
    name: z.string().min(1),
    serverVersion: z.string().min(1),
    migrations: z.object({ applied: count, latest: z.string().nullable() }),
    tables: z.record(z.string(), count),
    excludedData: z.array(z.string()),
    dumpFile: z.string().min(1),
    dumpBytes: count,
    dumpSha256: sha256Hex,
  }),
  storage: z
    .object({
      files: count,
      bytes: count,
      archive: z.string().min(1).nullable(),
      archiveSha256: sha256Hex.nullable(),
    })
    .refine((s) => (s.archive === null) === (s.archiveSha256 === null), 'archive and archiveSha256 must both be set or both null')
    .refine((s) => s.files === 0 || s.archive !== null, 'archive is required when files > 0'),
  tools: z.object({ pg_dump: z.string() }),
});

export type BackupManifest = z.infer<typeof backupManifestSchema>;

/** Validates a parsed manifest.json; a BackupError names the first offending field. */
export function parseManifest(raw: unknown): BackupManifest {
  const result = backupManifestSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue.path.length > 0 ? issue.path.join('.') : 'manifest';
    throw new BackupError(`invalid manifest.json: ${where}: ${issue.message}`);
  }
  for (const file of [result.data.database.dumpFile, result.data.storage.archive]) {
    if (file !== null && (file.includes('/') || file.includes('\\') || file.startsWith('.'))) {
      throw new BackupError(`invalid manifest.json: file name ${JSON.stringify(file)} is not a plain file name`);
    }
  }
  return result.data;
}

/** `blog0-<yyyymmddTHHMMSSZ>` (UTC). */
export function backupDirName(now: Date): string {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
  return `blog0-${stamp}`;
}

export interface ObservedRestore {
  /** Row count per table; `null` = the table does not exist in the target. */
  tables: Record<string, number | null>;
  files: number;
  bytes: number;
}

export interface RestoreCheckReport {
  ok: boolean;
  mismatches: number;
  lines: string[];
}

/** Per-table rows, files and bytes of the restored target vs the manifest. */
export function compareRestore(manifest: BackupManifest, observed: ObservedRestore): RestoreCheckReport {
  const tables = Object.entries(manifest.database.tables);
  const width = Math.max(5, ...tables.map(([t]) => t.length));
  const lines: string[] = [];
  let mismatches = 0;
  const row = (label: string, actual: number | null, expected: number) => {
    const ok = actual === expected;
    if (!ok) mismatches += 1;
    lines.push(`${label.padEnd(width)} ${actual === null ? 'missing' : actual} / ${expected} ${ok ? 'ok' : 'MISMATCH'}`);
  };
  let rows = 0;
  for (const [table, expected] of tables) {
    row(table, observed.tables[table] ?? null, expected);
    rows += expected;
  }
  row('files', observed.files, manifest.storage.files);
  row('bytes', observed.bytes, manifest.storage.bytes);
  lines.push(
    mismatches === 0
      ? `restore-check: OK (${tables.length} tables, ${rows} rows, ${manifest.storage.files} files)`
      : `restore-check: FAILED (${mismatches} mismatch${mismatches === 1 ? '' : 'es'})`,
  );
  return { ok: mismatches === 0, mismatches, lines };
}

// ---------------------------------------------------------------------------------------------
// CLI flags. A leading `--` (from `pnpm backup -- --out …`) is ignored.

export const BACKUP_USAGE = 'usage: pnpm backup -- --out <dir> [--storage <dir>]';
export const RESTORE_USAGE =
  'usage: pnpm restore -- --in <backupDir> --db <name|postgres://url> --storage <dir> [--force] [--check-only]';

function parseFlags<T extends Record<string, { type: 'string' | 'boolean' }>>(argv: readonly string[], options: T, usage: string) {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  try {
    return parseArgs({ args, options: { ...options, help: { type: 'boolean' } }, strict: true, allowPositionals: false }).values;
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
    throw new BackupUsageError(`${message.replace(/\. To specify .*$/, '')}\n${usage}`);
  }
}

function required(value: string | boolean | undefined, flag: string, usage: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new BackupUsageError(`missing ${flag}\n${usage}`);
  return value.trim();
}

export type ParsedCli<T> = { help: true } | ({ help: false } & T);

export function parseBackupArgs(argv: readonly string[]): ParsedCli<{ outDir: string; storageDir: string | null }> {
  const v = parseFlags(argv, { out: { type: 'string' }, storage: { type: 'string' } }, BACKUP_USAGE);
  if (v.help) return { help: true };
  const storage = typeof v.storage === 'string' && v.storage.trim() !== '' ? v.storage.trim() : null;
  return { help: false, outDir: required(v.out, '--out <dir>', BACKUP_USAGE), storageDir: storage };
}

export function parseRestoreArgs(
  argv: readonly string[],
): ParsedCli<{ inDir: string; db: string; storageDir: string; force: boolean; checkOnly: boolean }> {
  const v = parseFlags(
    argv,
    {
      in: { type: 'string' },
      db: { type: 'string' },
      storage: { type: 'string' },
      force: { type: 'boolean' },
      'check-only': { type: 'boolean' },
    },
    RESTORE_USAGE,
  );
  if (v.help) return { help: true };
  return {
    help: false,
    inDir: required(v.in, '--in <backupDir>', RESTORE_USAGE),
    db: required(v.db, '--db <name|postgres://url>', RESTORE_USAGE),
    storageDir: required(v.storage, '--storage <dir>', RESTORE_USAGE),
    force: v.force === true,
    checkOnly: v['check-only'] === true,
  };
}

const DB_NAME_RE = /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/;

/**
 * `--db`: a full postgres:// URL, or a bare database name that replaces the database name in
 * `baseUrl` (BLOG0_DATABASE_URL — host and credentials come from it). Throws BackupUsageError.
 */
export function resolveTargetUrl(db: string, baseUrl: string | undefined): string {
  if (/^postgres(ql)?:\/\//i.test(db)) {
    let url: URL;
    try {
      url = new URL(db);
    } catch {
      throw new BackupUsageError('--db must be a database name or a postgres:// URL with a database name');
    }
    if (url.pathname.length <= 1) throw new BackupUsageError('--db must be a database name or a postgres:// URL with a database name');
    return db;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(db)) throw new BackupUsageError(`--db: ${PGLITE_NOT_SUPPORTED}`);
  if (!DB_NAME_RE.test(db)) throw new BackupUsageError('--db must be a database name (letters, digits, _ $ -) or a postgres:// URL');
  const base = (baseUrl ?? '').replace(/\s+#.*$/, '').trim();
  if (!/^postgres(ql)?:\/\//i.test(base)) {
    throw new BackupUsageError(
      `--db ${db} takes host and credentials from BLOG0_DATABASE_URL, which is not a postgres:// URL — pass --db postgres://…/${db}`,
    );
  }
  const url = new URL(base);
  url.pathname = `/${encodeURIComponent(db)}`;
  return url.toString();
}
