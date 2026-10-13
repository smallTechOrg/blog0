import 'server-only';

import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import postgres from 'postgres';

import { ensurePostgresDatabase } from '../db/postgres';
import {
  BackupError,
  compareRestore,
  MANIFEST_FILE,
  parseManifest,
  type BackupManifest,
  type RestoreCheckReport,
} from './backup-manifest';
import { listStorageFiles, sha256File } from './backup';
import { assertToolVersion, databaseName, findPgTool, maskSecrets, parseVersion, pgEnv, runTool, type ToolEnv } from './pg-tools';

// `pnpm restore` (capability backup-restore; spec/architecture.md §12.3): verify the manifest and
// checksums BEFORE touching anything → create the target DB if missing → refuse a non-empty target
// (DB or storage dir) unless --force → `pg_restore --single-transaction` → extract the storage
// archive → restore-check (row/file/byte counts vs the manifest). Only ever touches the target DB
// and the target storage dir; `--check-only` only reads them.

const TAR_ENV = { COPYFILE_DISABLE: '1' };

export interface RestoreOptions {
  inDir: string;
  /** Target postgres:// URL (resolveTargetUrl for a bare --db name). */
  targetUrl: string;
  storageDir: string;
  force: boolean;
  checkOnly: boolean;
  out: (line: string) => void;
  toolEnv?: ToolEnv;
}

export async function readBackup(inDir: string): Promise<BackupManifest> {
  const file = path.join(inDir, MANIFEST_FILE);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new BackupError(`${inDir} has no ${MANIFEST_FILE} — not a blog0 backup (or an unfinished one)`);
    }
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BackupError(`${file} is not valid JSON`);
  }
  return parseManifest(raw);
}

async function verifyChecksum(inDir: string, file: string, expected: string): Promise<void> {
  const full = path.join(inDir, file);
  if (!existsSync(full)) throw new BackupError(`${file} is missing from ${inDir}`);
  const actual = await sha256File(full);
  if (actual !== expected) throw new BackupError(`checksum mismatch: ${file} (expected sha256 ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`);
}

/** A storage dir --force must never empty: `/`, the home dir, the cwd (repo root) or any ancestor, or one holding `.git`. */
export function unsafeStorageDir(dir: string): string | null {
  const abs = path.resolve(dir);
  const cwd = path.resolve(process.cwd());
  if (abs === path.parse(abs).root) return 'it is the filesystem root';
  if (abs === path.resolve(os.homedir())) return 'it is the home directory';
  if (abs === cwd || cwd.startsWith(`${abs}${path.sep}`)) return 'it contains the working directory (repo root)';
  if (existsSync(path.join(abs, '.git'))) return 'it contains .git';
  return null;
}

async function dirEntries(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Archive members must be relative paths without `..` segments. */
async function assertSafeArchive(archive: string, env: ToolEnv): Promise<void> {
  const { stdout } = await runTool('tar', ['-tzf', archive], { env });
  for (const member of stdout.split('\n').filter((m) => m !== '')) {
    if (member.startsWith('/') || member.split('/').includes('..')) {
      throw new BackupError(`refusing to extract the storage archive: unsafe member ${JSON.stringify(member)}`);
    }
  }
}

/** Rows per manifest table (null = table missing) and files/bytes under the storage dir. */
export async function restoreCheck(manifest: BackupManifest, targetUrl: string, storageDir: string): Promise<RestoreCheckReport> {
  const sql = postgres(targetUrl, { max: 1, connect_timeout: 5, onnotice: () => {} });
  const tables: Record<string, number | null> = {};
  try {
    for (const table of Object.keys(manifest.database.tables)) {
      const [{ exists }] = await sql<{ exists: boolean }[]>`select to_regclass(${`public."${table.replace(/"/g, '""')}"`}) is not null as exists`;
      if (!exists) {
        tables[table] = null;
        continue;
      }
      const [{ n }] = await sql.unsafe<{ n: string }[]>(`select count(*)::text as n from public."${table.replace(/"/g, '""')}"`);
      tables[table] = Number(n);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
  const files = await listStorageFiles(path.resolve(storageDir));
  return compareRestore(manifest, { tables, files: files.length, bytes: files.reduce((s, f) => s + f.bytes, 0) });
}

export async function restoreBackup(opts: RestoreOptions): Promise<RestoreCheckReport> {
  const inDir = path.resolve(opts.inDir);
  const storageDir = path.resolve(opts.storageDir);
  const conn = pgEnv(opts.targetUrl, opts.toolEnv ?? process.env);
  const dbName = databaseName(opts.targetUrl);
  const manifest = await readBackup(inDir);

  try {
    if (!opts.checkOnly) {
      // 1. Everything that can be checked without touching the target.
      await verifyChecksum(inDir, manifest.database.dumpFile, manifest.database.dumpSha256);
      if (manifest.storage.archive && manifest.storage.archiveSha256) {
        await verifyChecksum(inDir, manifest.storage.archive, manifest.storage.archiveSha256);
      }
      opts.out(`verified: ${manifest.database.dumpFile}${manifest.storage.archive ? ` + ${manifest.storage.archive}` : ''} sha256 ok`);
      const pgRestore = await findPgTool('pg_restore', opts.toolEnv);

      const storageEntries = await dirEntries(storageDir);
      if (storageEntries.length > 0) {
        const unsafe = unsafeStorageDir(storageDir);
        if (unsafe) throw new BackupError(`refusing to use ${storageDir} as the storage dir: ${unsafe}`);
        if (!opts.force) throw new BackupError(`${storageDir} is not empty (${storageEntries.length} entries) — pass --force to replace it`);
      }

      // 2. The target database.
      const created = await ensurePostgresDatabase(opts.targetUrl);
      const sql = postgres(opts.targetUrl, { max: 1, connect_timeout: 5, onnotice: () => {} });
      try {
        const [{ server_version }] = await sql<{ server_version: string }[]>`select current_setting('server_version') as server_version`;
        assertToolVersion(pgRestore, parseVersion(server_version) ?? server_version);
        const [{ tables, drizzle }] = await sql<{ tables: number; drizzle: boolean }[]>`
          select (select count(*)::int from pg_tables where schemaname in ('public', 'drizzle')) as tables,
                 exists (select 1 from pg_namespace where nspname = 'drizzle') as drizzle`;
        if (tables > 0 || drizzle) {
          if (!opts.force) throw new BackupError(`${dbName} is not empty (${tables} tables) — pass --force to replace it`);
          await sql.unsafe('drop schema if exists drizzle cascade; drop schema if exists public cascade; create schema public;');
          opts.out(`db: ${dbName} emptied (--force: dropped ${tables} tables)`);
        }
      } finally {
        await sql.end({ timeout: 5 });
      }
      await runTool(
        'pg_restore',
        ['--no-owner', '--no-acl', '--single-transaction', '--exit-on-error', `--dbname=${conn.dbname}`, path.join(inDir, manifest.database.dumpFile)],
        { env: conn.env, secrets: conn.secrets },
      );
      opts.out(`db: ${dbName} ${created === 'created' ? 'created and ' : ''}restored from ${manifest.database.name} (pg_restore ${pgRestore.version})`);

      // 3. The storage dir.
      if (storageEntries.length > 0) {
        for (const entry of storageEntries) await rm(path.join(storageDir, entry), { recursive: true, force: true });
      }
      await mkdir(storageDir, { recursive: true });
      if (manifest.storage.archive) {
        const archive = path.join(inDir, manifest.storage.archive);
        const tarEnv = { ...(opts.toolEnv ?? process.env), ...TAR_ENV };
        await assertSafeArchive(archive, tarEnv);
        await runTool('tar', ['-xzf', archive, '-C', storageDir], { env: tarEnv });
      }
      opts.out(`storage: ${manifest.storage.files} files restored to ${storageDir}`);
    } else {
      if (!existsSync(storageDir) || !(await stat(storageDir)).isDirectory()) {
        if (manifest.storage.files > 0) opts.out(`note: ${storageDir} does not exist`);
      }
    }

    // 4. restore-check.
    const report = await restoreCheck(manifest, opts.targetUrl, storageDir);
    for (const line of report.lines) opts.out(line);
    return report;
  } catch (error) {
    if (error instanceof BackupError) throw new BackupError(maskSecrets(error.message, conn.secrets));
    throw new BackupError(maskSecrets(error instanceof Error ? error.message : String(error), conn.secrets));
  }
}
