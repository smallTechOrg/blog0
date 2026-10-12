import 'server-only';

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import postgres from 'postgres';

import { APP_VERSION } from '../config';
import { readJournal } from '../db/migrate';
import { parseDatabaseUrl } from '../db/url';
import {
  ARCHIVE_FILE,
  BACKUP_FORMAT,
  BACKUP_TABLES,
  BackupError,
  backupDirName,
  BackupUsageError,
  DUMP_FILE,
  EXCLUDED_DATA_TABLES,
  MANIFEST_FILE,
  PGLITE_NOT_SUPPORTED,
  type BackupManifest,
} from './backup-manifest';
import { assertToolVersion, databaseName, findPgTool, maskSecrets, parseVersion, pgEnv, runTool, type ToolEnv } from './pg-tools';

// `pnpm backup` (capability backup-restore; spec/architecture.md §12.3): one repeatable-read
// read-only transaction exports a snapshot; the per-table row counts AND `pg_dump --snapshot` read
// that same snapshot, so the manifest always matches the dump. Then the storage dir is archived,
// both files are hashed and manifest.json is written last. Any failure removes the new backup dir.

const MIGRATIONS_LEDGER = 'drizzle.__drizzle_migrations';

/** bsdtar (macOS) would add `._*` AppleDouble members for files with extended attributes. */
const TAR_ENV = { COPYFILE_DISABLE: '1' };

export interface StorageFile {
  /** Path relative to the storage root, `/`-separated. */
  rel: string;
  bytes: number;
}

/** Every regular file under `root` (symlinks and other specials are skipped); missing root → []. */
export async function listStorageFiles(root: string): Promise<StorageFile[]> {
  const files: StorageFile[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && prefix === '') return;
      throw error;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs, rel);
      else if (entry.isFile()) files.push({ rel, bytes: (await lstat(abs)).size });
    }
  }
  await walk(root, '');
  return files;
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export interface CreateBackupOptions {
  /** BLOG0_DATABASE_URL (postgres:// only). */
  databaseUrl: string | undefined;
  outDir: string;
  storageDir: string;
  now?: Date;
  out: (line: string) => void;
  /** Environment for the spawned tools (PATH lookup); default process.env. */
  toolEnv?: ToolEnv;
  /** Test hook: runs inside the snapshot transaction after the counts, before pg_dump. */
  afterSnapshot?: () => Promise<void>;
}

export interface BackupResult {
  dir: string;
  manifest: BackupManifest;
}

interface SnapshotCapture {
  serverVersion: string;
  tables: Record<string, number>;
  migrations: { applied: number; latest: string | null };
  storageKeys: string[];
}

export async function createBackup(opts: CreateBackupOptions): Promise<BackupResult> {
  const target = parseDatabaseUrl(opts.databaseUrl);
  if (target.engine !== 'postgres') throw new BackupUsageError(PGLITE_NOT_SUPPORTED);
  const url = target.url;
  const conn = pgEnv(url, opts.toolEnv ?? process.env);
  // Tool lookup before any DB connection: a missing pg_dump is reported as such, never masked by a
  // connection/auth error (the CLI exit-1 contract).
  const pgDump = await findPgTool('pg_dump', opts.toolEnv);

  const storageRoot = path.resolve(opts.storageDir);
  await mkdir(opts.outDir, { recursive: true });
  const dir = path.resolve(opts.outDir, backupDirName(opts.now ?? new Date()));
  try {
    await mkdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new BackupError(`${dir} already exists — wait a second and retry`);
    throw error;
  }

  const dumpPath = path.join(dir, DUMP_FILE);
  try {
    const capture = await dumpFromSnapshot(url, async (snapshotId, serverVersion) => {
      assertToolVersion(pgDump, serverVersion);
      await runTool(
        'pg_dump',
        [
          '--format=custom',
          '--no-owner',
          '--no-acl',
          `--snapshot=${snapshotId}`,
          ...EXCLUDED_DATA_TABLES.map((t) => `--exclude-table-data=public.${t}`),
          `--file=${dumpPath}`,
          `--dbname=${conn.dbname}`,
        ],
        { env: conn.env, secrets: conn.secrets },
      );
    }, opts.afterSnapshot);

    const files = await listStorageFiles(storageRoot);
    const bytes = files.reduce((sum, f) => sum + f.bytes, 0);
    let archiveSha256: string | null = null;
    if (files.length > 0) {
      const archivePath = path.join(dir, ARCHIVE_FILE);
      await runTool('tar', ['-czf', archivePath, '-C', storageRoot, '--null', '-T', '-'], {
        env: { ...(opts.toolEnv ?? process.env), ...TAR_ENV },
        input: Buffer.from(files.map((f) => `./${f.rel}\0`).join(''), 'utf8'),
      });
      archiveSha256 = await sha256File(archivePath);
    }

    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      createdAt: (opts.now ?? new Date()).toISOString(),
      appVersion: APP_VERSION,
      database: {
        name: databaseName(url),
        serverVersion: capture.serverVersion,
        migrations: capture.migrations,
        tables: capture.tables,
        excludedData: [...EXCLUDED_DATA_TABLES],
        dumpFile: DUMP_FILE,
        dumpBytes: (await stat(dumpPath)).size,
        dumpSha256: await sha256File(dumpPath),
      },
      storage: { files: files.length, bytes, archive: archiveSha256 ? ARCHIVE_FILE : null, archiveSha256 },
      tools: { pg_dump: pgDump.version },
    };
    // manifest.json last (and atomically): a directory without it is not a backup.
    const tmp = path.join(dir, `${MANIFEST_FILE}.tmp`);
    await writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await rename(tmp, path.join(dir, MANIFEST_FILE));

    const rows = Object.values(manifest.database.tables).reduce((a, b) => a + b, 0);
    opts.out(`backup: ${dir}`);
    opts.out(
      `db: ${manifest.database.name} — ${Object.keys(manifest.database.tables).length} tables, ${rows} rows, dump ${manifest.database.dumpBytes} bytes`,
    );
    opts.out(`storage: ${files.length} files, ${bytes} bytes`);
    const archived = new Set(files.map((f) => f.rel));
    const orphaned = capture.storageKeys.filter((key) => !archived.has(key)).length;
    if (orphaned > 0) opts.out(`warning: ${orphaned} media_asset rows have no file in the archive`);
    opts.out(dir);
    return { dir, manifest };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    if (error instanceof BackupError || error instanceof BackupUsageError) throw error;
    throw new BackupError(maskSecrets(error instanceof Error ? error.message : String(error), conn.secrets));
  }
}

/**
 * Opens a repeatable-read read-only transaction, exports its snapshot, captures counts + ledger +
 * media keys, then runs `dump(snapshotId)` while the transaction is still open.
 */
async function dumpFromSnapshot(
  url: string,
  dump: (snapshotId: string, serverVersion: string) => Promise<void>,
  afterSnapshot?: () => Promise<void>,
): Promise<SnapshotCapture> {
  const sql = postgres(url, { max: 1, connect_timeout: 5, idle_timeout: 5, onnotice: () => {} });
  try {
    return await sql.begin('isolation level repeatable read read only', async (tx) => {
      const [{ snapshot }] = await tx<{ snapshot: string }[]>`select pg_export_snapshot() as snapshot`;
      const [{ server_version }] = await tx<{ server_version: string }[]>`select current_setting('server_version') as server_version`;
      const serverVersion = parseVersion(server_version) ?? server_version;

      const regs = await tx<{ name: string; exists: boolean }[]>`
        select t.name, to_regclass('public.' || quote_ident(t.name)) is not null as exists
        from unnest(${tx.array([...BACKUP_TABLES])}::text[]) as t(name)`;
      const missing = regs.filter((r) => !r.exists).map((r) => r.name);
      if (missing.length > 0) {
        throw new BackupError(`table(s) missing in the source database: ${missing.join(', ')} — run pnpm db:migrate first`);
      }
      const tables: Record<string, number> = {};
      for (const table of BACKUP_TABLES) {
        const [{ n }] = await tx.unsafe<{ n: string }[]>(`select count(*)::text as n from public."${table}"`);
        tables[table] = Number(n);
      }

      const [ledger] = await tx<{ exists: boolean }[]>`select to_regclass(${MIGRATIONS_LEDGER}) is not null as exists`;
      let migrations: SnapshotCapture['migrations'] = { applied: 0, latest: null };
      if (ledger.exists) {
        const rows = await tx.unsafe<{ created_at: string }[]>(`select created_at::text as created_at from ${MIGRATIONS_LEDGER}`);
        const appliedMillis = new Set(rows.map((r) => Number(r.created_at)));
        // Same rule as `pnpm db:verify`: journal entries matched by their `when` timestamp.
        const applied = readJournal().filter((e) => appliedMillis.has(e.when)).map((e) => e.tag);
        migrations = { applied: applied.length, latest: applied.length > 0 ? applied[applied.length - 1] : null };
      }

      const keys = await tx<{ storage_key: string }[]>`select storage_key from media_asset`;
      if (afterSnapshot) await afterSnapshot();
      await dump(snapshot, serverVersion);
      return { serverVersion, tables, migrations, storageKeys: keys.map((k) => k.storage_key) };
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
