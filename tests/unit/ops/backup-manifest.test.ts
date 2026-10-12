// Backup manifest, restore-check comparison, CLI flags and client-tool helpers (capability
// backup-restore; spec/architecture.md §12.3). Pure — no database, no spawned tools.
import { describe, expect, it } from 'vitest';

import { ALL_TABLE_NAMES } from '@/server/db/schema';
import {
  BACKUP_TABLES,
  BackupError,
  backupDirName,
  BackupUsageError,
  compareRestore,
  parseBackupArgs,
  parseManifest,
  parseRestoreArgs,
  resolveTargetUrl,
  type BackupManifest,
} from '@/server/ops/backup-manifest';
import { assertToolVersion, maskSecrets, parseVersion, pgEnv } from '@/server/ops/pg-tools';

const HEX = 'a'.repeat(64);

function manifest(overrides: Partial<BackupManifest['storage']> = {}): BackupManifest {
  return {
    format: 'blog0-backup/1',
    createdAt: '2026-10-13T02:00:00.000Z',
    appVersion: '0.1.0',
    database: {
      name: 'blog0_dev',
      serverVersion: '18.1',
      migrations: { applied: 2, latest: '0001_rate_limit_bucket' },
      tables: { site: 1, app_user: 2, article: 6 },
      excludedData: ['rate_limit_bucket'],
      dumpFile: 'db.dump',
      dumpBytes: 1234,
      dumpSha256: HEX,
    },
    storage: { files: 3, bytes: 4567, archive: 'storage.tar.gz', archiveSha256: HEX, ...overrides },
    tools: { pg_dump: '18.1' },
  };
}

describe('BACKUP_TABLES', () => {
  it('is every table except rate_limit_bucket, parents first', () => {
    expect([...BACKUP_TABLES].sort()).toEqual(ALL_TABLE_NAMES.filter((t) => t !== 'rate_limit_bucket').sort());
    expect(BACKUP_TABLES).not.toContain('rate_limit_bucket');
    expect(BACKUP_TABLES[0]).toBe('site');
  });
});

describe('backupDirName', () => {
  it('is blog0-<yyyymmddTHHMMSSZ> in UTC', () => {
    expect(backupDirName(new Date('2026-10-13T02:03:04.567Z'))).toBe('blog0-20261013T020304Z');
  });
});

describe('parseManifest', () => {
  it('accepts a valid manifest (and null archive when there are no files)', () => {
    expect(parseManifest(manifest())).toEqual(manifest());
    const empty = manifest({ files: 0, bytes: 0, archive: null, archiveSha256: null });
    expect(parseManifest(JSON.parse(JSON.stringify(empty)))).toEqual(empty);
  });

  it('rejects a wrong format, a bad digest, a negative count and a missing archive', () => {
    expect(() => parseManifest({ ...manifest(), format: 'blog0-backup/2' })).toThrow(/invalid manifest.json: format/);
    expect(() => parseManifest({ ...manifest(), database: { ...manifest().database, dumpSha256: 'xyz' } })).toThrow(
      /database\.dumpSha256: must be a sha256 hex digest/,
    );
    expect(() => parseManifest({ ...manifest(), database: { ...manifest().database, tables: { site: -1 } } })).toThrow(BackupError);
    expect(() => parseManifest(manifest({ archive: null, archiveSha256: null }))).toThrow(/archive is required when files > 0/);
    expect(() => parseManifest(manifest({ archiveSha256: null }))).toThrow(/both be set or both null/);
    expect(() => parseManifest(null)).toThrow(/invalid manifest.json/);
  });

  it('rejects file names that escape the backup dir', () => {
    expect(() => parseManifest({ ...manifest(), database: { ...manifest().database, dumpFile: '../etc/passwd' } })).toThrow(
      /not a plain file name/,
    );
  });
});

describe('compareRestore', () => {
  it('all equal → ok, one line per table + files + bytes + the OK summary', () => {
    const report = compareRestore(manifest(), { tables: { site: 1, app_user: 2, article: 6 }, files: 3, bytes: 4567 });
    expect(report.ok).toBe(true);
    expect(report.mismatches).toBe(0);
    expect(report.lines).toEqual([
      'site     1 / 1 ok',
      'app_user 2 / 2 ok',
      'article  6 / 6 ok',
      'files    3 / 3 ok',
      'bytes    4567 / 4567 ok',
      'restore-check: OK (3 tables, 9 rows, 3 files)',
    ]);
  });

  it('a row difference, a missing table and a missing file are each a MISMATCH', () => {
    const report = compareRestore(manifest(), { tables: { site: 1, app_user: 3 }, files: 2, bytes: 4000 });
    expect(report.ok).toBe(false);
    expect(report.mismatches).toBe(4);
    expect(report.lines).toContain('app_user 3 / 2 MISMATCH');
    expect(report.lines).toContain('article  missing / 6 MISMATCH');
    expect(report.lines).toContain('files    2 / 3 MISMATCH');
    expect(report.lines.at(-1)).toBe('restore-check: FAILED (4 mismatches)');
  });
});

describe('CLI flags', () => {
  it('backup: ignores a leading --, requires --out, --storage optional', () => {
    expect(parseBackupArgs(['--', '--out', 'var/backups'])).toEqual({ help: false, outDir: 'var/backups', storageDir: null });
    expect(parseBackupArgs(['--out=x', '--storage', 's'])).toEqual({ help: false, outDir: 'x', storageDir: 's' });
    expect(parseBackupArgs(['--help'])).toEqual({ help: true });
    expect(() => parseBackupArgs([])).toThrow(BackupUsageError);
    expect(() => parseBackupArgs(['--out', 'x', '--bogus'])).toThrow(/Unknown option '--bogus'[\s\S]*usage: pnpm backup/);
    expect(() => parseBackupArgs(['--out', 'x', 'stray'])).toThrow(BackupUsageError);
  });

  it('restore: --in, --db, --storage required; --force / --check-only flags', () => {
    expect(parseRestoreArgs(['--', '--in', 'b', '--db', 'x', '--storage', 's', '--force'])).toEqual({
      help: false,
      inDir: 'b',
      db: 'x',
      storageDir: 's',
      force: true,
      checkOnly: false,
    });
    expect(parseRestoreArgs(['--in', 'b', '--db', 'x', '--storage', 's', '--check-only'])).toMatchObject({ checkOnly: true, force: false });
    expect(() => parseRestoreArgs(['--in', 'b', '--storage', 's'])).toThrow(/missing --db/);
    expect(() => parseRestoreArgs(['--in', 'b', '--db', '', '--storage', 's'])).toThrow(/missing --db/);
  });

  it('resolveTargetUrl: a bare name swaps the database of BLOG0_DATABASE_URL; URLs pass through', () => {
    expect(resolveTargetUrl('blog0_restore_check', 'postgres://sai:pw@db.local:5433/blog0_dev?sslmode=require')).toBe(
      'postgres://sai:pw@db.local:5433/blog0_restore_check?sslmode=require',
    );
    expect(resolveTargetUrl('postgres://u@h/x', undefined)).toBe('postgres://u@h/x');
    expect(() => resolveTargetUrl('x', 'pglite://./var/pglite')).toThrow(/not a postgres:\/\/ URL/);
    expect(() => resolveTargetUrl('x', undefined)).toThrow(BackupUsageError);
    expect(() => resolveTargetUrl('pglite://./var/x', undefined)).toThrow(/backups cover Postgres only/);
    expect(() => resolveTargetUrl('bad name;', 'postgres://u@h/x')).toThrow(/must be a database name/);
    expect(() => resolveTargetUrl('postgres://u@h/', undefined)).toThrow(/with a database name/);
  });
});

describe('client tools', () => {
  it('parseVersion reads pg_dump --version and server_version', () => {
    expect(parseVersion('pg_dump (PostgreSQL) 18.1 (Homebrew)')).toBe('18.1');
    expect(parseVersion('18.1 (Homebrew)')).toBe('18.1');
    expect(parseVersion('pg_restore (PostgreSQL) 19devel')).toBe('19');
    expect(parseVersion('nothing')).toBeNull();
  });

  it('assertToolVersion: client major ≥ server major, else an error naming both versions', () => {
    expect(() => assertToolVersion({ tool: 'pg_dump', version: '18.1' }, '18.0')).not.toThrow();
    expect(() => assertToolVersion({ tool: 'pg_dump', version: '19.0' }, '18.1')).not.toThrow();
    expect(() => assertToolVersion({ tool: 'pg_dump', version: '17.6' }, '18.1')).toThrow(
      /pg_dump 17\.6 is older than the server \(PostgreSQL 18\.1\) — install the PostgreSQL 18 client tools/,
    );
  });

  it('pgEnv moves the password into PGPASSWORD and out of the --dbname URI', () => {
    const { dbname, env, secrets } = pgEnv('postgres://sai:p%40ss@localhost:5432/blog0_dev?sslmode=disable', { PATH: '/bin', PGPASSWORD: 'old' });
    expect(dbname).toBe('postgres://sai@localhost:5432/blog0_dev?sslmode=disable');
    expect(env).toEqual({ PATH: '/bin', PGPASSWORD: 'p@ss' });
    expect(secrets).toContain('p@ss');
    const none = pgEnv('postgres://sai@localhost/x', { PGPASSWORD: 'stale' });
    expect(none.env.PGPASSWORD).toBeUndefined();
    expect(none.secrets).toEqual([]);
  });

  it('maskSecrets replaces every occurrence', () => {
    expect(maskSecrets('a pw b pw', ['pw'])).toBe('a *** b ***');
    expect(maskSecrets('unchanged', [''])).toBe('unchanged');
  });
});
