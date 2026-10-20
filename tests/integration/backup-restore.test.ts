// Backup + restore (capability backup-restore; spec/architecture.md §12.3) against real Postgres
// with the real pg_dump / pg_restore / tar, in OWN databases: BLOG0_TEST_DATABASE_URL suffixed
// `_restore_src` (the backed-up source) and `_restore` / `_restore_tamper` (restore targets) —
// created and dropped here, never blog0_test's schema. Storage dirs live under var/backup-test
// (removed afterwards). Needs PostgreSQL 18 client tools on PATH — NOT skipped when missing: the
// first test fails with the install hint. No LLM is involved, so there is no real-key call.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDbHandle, type DbHandle } from '@/server/db/client';
import { getMigrationStatus, readJournal, runMigrations } from '@/server/db/migrate';
import { ensurePostgresDatabase } from '@/server/db/postgres';
import { mediaAsset, newsletterSubscriber, rateLimitBucket } from '@/server/db/schema';
import { BACKUP_TABLES, BackupError, BackupUsageError, type BackupManifest } from '@/server/ops/backup-manifest';
import { createBackup, sha256File } from '@/server/ops/backup';
import { findPgTool } from '@/server/ops/pg-tools';
import { restoreBackup } from '@/server/ops/restore';
import { seedAdmin } from '@/server/seed/admin';
import { seedSite } from '@/server/seed/site';

import { getTestDatabaseUrl } from '../helpers/env';

const ROOT = process.cwd();
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const WORK = path.join(ROOT, 'var', 'backup-test');
const SRC_STORAGE = path.join(WORK, 'src-storage');
const OUT = path.join(WORK, 'out');
const JOURNAL = readJournal();

function withDb(suffix: string): string {
  const url = new URL(getTestDatabaseUrl());
  url.pathname = `${url.pathname}${suffix}`;
  return url.toString();
}

const SRC_URL = withDb('_restore_src');
const TARGET_URL = withDb('_restore');
const TAMPER_URL = withDb('_restore_tamper');
// The CLI password-leak tests need a URL whose password is (a) accepted by the server under ANY
// auth method (trust locally, scram/md5 in CI) and (b) distinctive enough that "the output never
// contains it" means something (CI's real password is `postgres`, which is also the user name).
// So they connect as a throwaway login role with a distinctive password, created and dropped here.
const PASSWORD = 'Zx9-backup-SECRET-pw';
const PW_ROLE = `blog0_backup_pw_${process.pid}`;
const withPassword = (url: string): string => {
  const u = new URL(url);
  u.username = PW_ROLE;
  u.password = PASSWORD;
  return u.toString();
};
/** A PATH without pg_dump: an empty dir (CI's /usr/bin has the Debian pg_wrapper pg_dump). */
const EMPTY_PATH = path.join(WORK, 'empty-path');
const dbNameOf = (url: string) => decodeURIComponent(new URL(url).pathname.slice(1));

async function admin<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const u = new URL(SRC_URL);
  u.pathname = '/postgres';
  const sql = postgres(u.toString(), { max: 1, connect_timeout: 5, onnotice: () => {} });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const dropDatabase = (url: string) => admin((sql) => sql.unsafe(`drop database if exists "${dbNameOf(url)}" with (force)`));
const databaseExists = (url: string) =>
  admin(async (sql) => (await sql`select 1 from pg_database where datname = ${dbNameOf(url)}`).length > 0);

async function count(url: string, table: string): Promise<number> {
  const sql = postgres(url, { max: 1, connect_timeout: 5, onnotice: () => {} });
  try {
    const [{ n }] = await sql.unsafe<{ n: string }[]>(`select count(*)::text as n from public."${table}"`);
    return Number(n);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function backup(extra: Partial<Parameters<typeof createBackup>[0]> = {}) {
  const lines: string[] = [];
  const result = await createBackup({ databaseUrl: SRC_URL, outDir: OUT, storageDir: SRC_STORAGE, out: (l) => lines.push(l), ...extra });
  return { ...result, lines };
}

async function restore(inDir: string, storageDir: string, extra: Partial<Parameters<typeof restoreBackup>[0]> = {}) {
  const lines: string[] = [];
  const report = await restoreBackup({
    inDir,
    targetUrl: TARGET_URL,
    storageDir,
    force: false,
    checkOnly: false,
    out: (l) => lines.push(l),
    ...extra,
  });
  return { report, lines };
}

function cli(script: 'backup' | 'restore', args: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, [TSX, `scripts/${script}.ts`, '--', ...args], {
    cwd: ROOT,
    env: { NODE_ENV: 'production', HOME: process.env.HOME ?? '', PATH: process.env.PATH ?? '', BLOG0_STORAGE_DIR: SRC_STORAGE, ...env },
    encoding: 'utf8',
    timeout: 90_000,
  });
}

let src: DbHandle;
let mediaKey: string;

beforeAll(async () => {
  // Fails (not skips) without the client tools — with the install hint.
  await findPgTool('pg_dump');
  await findPgTool('pg_restore');

  rmSync(WORK, { recursive: true, force: true });
  for (const url of [SRC_URL, TARGET_URL, TAMPER_URL]) await dropDatabase(url);
  await admin(async (sql) => {
    await sql.unsafe(`drop role if exists "${PW_ROLE}"`);
    await sql.unsafe(`create role "${PW_ROLE}" login superuser password '${PASSWORD}'`);
  });
  await ensurePostgresDatabase(SRC_URL);
  await runMigrations(SRC_URL);
  src = await createDbHandle({ engine: 'postgres', url: SRC_URL }, { max: 1 });

  const { site } = await seedSite(src.db, 'blog0');
  const { userId } = await seedAdmin(src.db, site.id, {
    email: 'backup.admin@example.com',
    displayName: 'Backup Admin',
    password: 'backup-pass-0123456789',
  });
  await src.db.insert(newsletterSubscriber).values(
    Array.from({ length: 4 }, (_, i) => ({ siteId: site.id, email: `reader${i}@example.com` })),
  );
  mediaKey = 'blog0/image/2026/10/0000-test.png';
  await src.db.insert(mediaAsset).values({
    siteId: site.id,
    kind: 'image',
    storageKey: mediaKey,
    originalFilename: 'test.png',
    mimeType: 'image/png',
    byteSize: 6,
    sha256: 'b'.repeat(64),
    createdBy: userId,
  });
  await src.db.insert(rateLimitBucket).values({
    siteId: site.id,
    scope: 'login',
    keyHash: 'c'.repeat(64),
    windowStart: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    count: 3,
  });

  mkdirSync(path.join(SRC_STORAGE, 'blog0/image/2026/10'), { recursive: true });
  mkdirSync(path.join(SRC_STORAGE, 'blog0/audio/2026/10'), { recursive: true });
  writeFileSync(path.join(SRC_STORAGE, mediaKey), 'PNGPNG');
  writeFileSync(path.join(SRC_STORAGE, 'blog0/audio/2026/10/0001 with space.mp3'), 'ID3-audio-bytes');
  symlinkSync('/etc/hosts', path.join(SRC_STORAGE, 'blog0/link-is-skipped')); // not a regular file
});

afterAll(async () => {
  await src?.close();
  rmSync(WORK, { recursive: true, force: true });
  for (const url of [SRC_URL, TARGET_URL, TAMPER_URL]) await dropDatabase(url);
  await admin((sql) => sql.unsafe(`drop role if exists "${PW_ROLE}"`));
});

describe('backup → restore round trip', () => {
  let dir: string;
  let manifest: BackupManifest;

  it('backup writes db.dump + storage.tar.gz + manifest.json with snapshot counts; throttle rows excluded', async () => {
    const result = await backup();
    dir = result.dir;
    manifest = result.manifest;

    expect(path.basename(dir)).toMatch(/^blog0-\d{8}T\d{6}Z$/);
    expect(existsSync(path.join(dir, 'db.dump'))).toBe(true);
    expect(existsSync(path.join(dir, 'storage.tar.gz'))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'))).toEqual(manifest);

    expect(Object.keys(manifest.database.tables).sort()).toEqual([...BACKUP_TABLES].sort());
    for (const table of BACKUP_TABLES) expect(manifest.database.tables[table], table).toBe(await count(SRC_URL, table));
    expect(manifest.database.tables).toMatchObject({ site: 1, app_user: 1, newsletter_subscriber: 4, media_asset: 1 });
    expect(manifest.database.excludedData).toEqual(['rate_limit_bucket']);
    expect(manifest.database.name).toBe(dbNameOf(SRC_URL));
    expect(manifest.database.serverVersion).toMatch(/^\d+(\.\d+)?$/);
    expect(manifest.database.migrations).toEqual({ applied: JOURNAL.length, latest: JOURNAL.at(-1)!.tag });
    expect(manifest.database.dumpSha256).toBe(await sha256File(path.join(dir, 'db.dump')));
    expect(manifest.storage).toEqual({
      files: 2,
      bytes: 6 + 'ID3-audio-bytes'.length,
      archive: 'storage.tar.gz',
      archiveSha256: await sha256File(path.join(dir, 'storage.tar.gz')),
    });

    expect(result.lines[0]).toBe(`backup: ${dir}`);
    expect(result.lines[1]).toMatch(new RegExp(`^db: ${dbNameOf(SRC_URL)} — 16 tables, \\d+ rows, dump \\d+ bytes$`));
    expect(result.lines[2]).toBe(`storage: 2 files, ${manifest.storage.bytes} bytes`);
    expect(result.lines.at(-1)).toBe(dir);
    expect(result.lines.join('\n')).not.toMatch(/warning/);
  });

  it('restore into a fresh DB + empty storage dir → restore-check OK; ledger and files match the source', async () => {
    const storage = path.join(WORK, 'restore-storage');
    const { report, lines } = await restore(dir, storage);

    expect(report.ok).toBe(true);
    expect(lines.at(-1)).toMatch(/^restore-check: OK \(16 tables, \d+ rows, 2 files\)$/);
    expect(lines).toContain(`db: ${dbNameOf(TARGET_URL)} created and restored from ${dbNameOf(SRC_URL)} (pg_restore ${(await findPgTool('pg_restore')).version})`);
    expect(await count(TARGET_URL, 'newsletter_subscriber')).toBe(4);
    expect(await count(TARGET_URL, 'rate_limit_bucket')).toBe(0); // schema restored, rows not
    const status = await getMigrationStatus(TARGET_URL);
    expect(status.applied).toHaveLength(JOURNAL.length);
    expect(status.pending).toEqual([]);
    expect(readFileSync(path.join(storage, mediaKey), 'utf8')).toBe('PNGPNG');
    expect(existsSync(path.join(storage, 'blog0/audio/2026/10/0001 with space.mp3'))).toBe(true);
    expect(existsSync(path.join(storage, 'blog0/link-is-skipped'))).toBe(false);
  });

  it('a second restore without --force is refused (DB not empty) and changes nothing; with --force → OK', async () => {
    const storage = path.join(WORK, 'restore-storage-2');
    const refused = await restore(dir, storage).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(BackupError);
    expect((refused as Error).message).toMatch(new RegExp(`^${dbNameOf(TARGET_URL)} is not empty \\(\\d+ tables\\) — pass --force to replace it$`));
    expect(existsSync(storage)).toBe(false);

    const forced = await restore(dir, path.join(WORK, 'restore-storage'), { force: true });
    expect(forced.report.ok).toBe(true);
    expect(forced.lines).toEqual(expect.arrayContaining([expect.stringMatching(/^db: .* emptied \(--force: dropped \d+ tables\)$/)]));
  });

  it('a non-empty storage dir is refused without --force (before the DB is touched)', async () => {
    const storage = path.join(WORK, 'busy-storage');
    mkdirSync(storage, { recursive: true });
    writeFileSync(path.join(storage, 'keep.txt'), 'x');
    await dropDatabase(TAMPER_URL);
    const err = await restore(dir, storage, { targetUrl: TAMPER_URL }).catch((e: unknown) => e);
    expect((err as Error).message).toBe(`${storage} is not empty (1 entries) — pass --force to replace it`);
    expect(await databaseExists(TAMPER_URL)).toBe(false);
  });

  it('--force never empties a dir holding .git (or the repo root)', async () => {
    const storage = path.join(WORK, 'looks-like-a-repo');
    mkdirSync(path.join(storage, '.git'), { recursive: true });
    const err = await restore(dir, storage, { force: true, targetUrl: TAMPER_URL }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/refusing to use .* as the storage dir: it contains \.git/);
    expect(existsSync(path.join(storage, '.git'))).toBe(true);

    const root = await restore(dir, ROOT, { force: true, targetUrl: TAMPER_URL }).catch((e: unknown) => e);
    expect((root as Error).message).toMatch(/refusing to use .* as the storage dir/);
    expect(await databaseExists(TAMPER_URL)).toBe(false);
  });

  it('--check-only after deleting one restored file → files MISMATCH (state survives a fresh run)', async () => {
    const storage = path.join(WORK, 'restore-storage');
    rmSync(path.join(storage, mediaKey));
    const { report, lines } = await restore(dir, storage, { checkOnly: true });
    expect(report.ok).toBe(false);
    expect(lines).toEqual(expect.arrayContaining([expect.stringMatching(/^files +1 \/ 2 MISMATCH$/)]));
    expect(lines).toEqual(expect.arrayContaining([expect.stringMatching(/^bytes +15 \/ 21 MISMATCH$/)]));
    expect(lines.at(-1)).toBe('restore-check: FAILED (2 mismatches)');
    // tables still match
    expect(lines.filter((l) => / ok$/.test(l))).toHaveLength(16);
  });

  it('a one-byte tamper of db.dump → checksum mismatch before the target DB is created', async () => {
    const tampered = path.join(WORK, 'tampered');
    mkdirSync(tampered, { recursive: true });
    for (const f of ['db.dump', 'storage.tar.gz', 'manifest.json']) writeFileSync(path.join(tampered, f), readFileSync(path.join(dir, f)));
    const bytes = readFileSync(path.join(tampered, 'db.dump'));
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    writeFileSync(path.join(tampered, 'db.dump'), bytes);

    await dropDatabase(TAMPER_URL);
    const err = await restore(tampered, path.join(WORK, 'tamper-storage'), { targetUrl: TAMPER_URL }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackupError);
    expect((err as Error).message).toMatch(/^checksum mismatch: db\.dump/);
    expect(await databaseExists(TAMPER_URL)).toBe(false);
    expect(existsSync(path.join(WORK, 'tamper-storage'))).toBe(false);
  });

  it('a directory without manifest.json is not a backup', async () => {
    const half = path.join(WORK, 'half');
    mkdirSync(half, { recursive: true });
    writeFileSync(path.join(half, 'db.dump'), 'x');
    await expect(restore(half, path.join(WORK, 'x'))).rejects.toThrow(/has no manifest\.json — not a blog0 backup/);
  });
});

describe('consistency under concurrent writes', () => {
  it('rows inserted while the backup runs never make restore-check fail (one snapshot for counts + dump)', async () => {
    const [{ id: siteId }] = await src.db.select({ id: newsletterSubscriber.siteId }).from(newsletterSubscriber).limit(1);
    const before = await count(SRC_URL, 'newsletter_subscriber');
    let n = 0;
    let running = true;
    const insertOne = () => src.db.insert(newsletterSubscriber).values({ siteId, email: `live${n++}@example.com` });
    const writer = (async () => {
      while (running) await insertOne();
    })();

    let result;
    try {
      // Deterministic overlap: committed writes land after the snapshot, before pg_dump starts.
      result = await backup({ now: new Date(Date.now() + 3_600_000), afterSnapshot: async () => { await insertOne(); await insertOne(); } });
    } finally {
      running = false;
      await writer;
    }
    expect(n).toBeGreaterThanOrEqual(2);
    expect(await count(SRC_URL, 'newsletter_subscriber')).toBe(before + n);
    expect(result.manifest.database.tables.newsletter_subscriber).toBeLessThan(before + n);

    const { report, lines } = await restore(result.dir, path.join(WORK, 'concurrent-storage'), { force: true });
    expect(lines.at(-1)).toMatch(/^restore-check: OK/);
    expect(report.ok).toBe(true);
    expect(await count(TARGET_URL, 'newsletter_subscriber')).toBe(result.manifest.database.tables.newsletter_subscriber);
  });
});

describe('error paths', () => {
  it('pg_dump missing from PATH → install hint, no backup dir left behind', async () => {
    const err = await backup({ toolEnv: { PATH: '/nonexistent' } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackupError);
    expect((err as Error).message).toBe(
      'pg_dump not found on PATH — install the PostgreSQL 18 client tools (macOS: brew install postgresql@18; Debian/Ubuntu: apt install postgresql-client-18)',
    );
  });

  it('a pglite:// (or absent) database URL is a usage error', async () => {
    await expect(backup({ databaseUrl: 'pglite://./var/pglite' })).rejects.toBeInstanceOf(BackupUsageError);
    await expect(backup({ databaseUrl: undefined })).rejects.toThrow(/backups cover Postgres only/);
  });

  it('an unreachable database fails and removes the partial backup dir', async () => {
    const out = path.join(WORK, 'unreachable');
    const err = await backup({ databaseUrl: 'postgres://nobody:pw-should-hide@127.0.0.1:1/nothing', outDir: out }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackupError);
    expect((err as Error).message).not.toContain('pw-should-hide');
    expect(readdirOrEmpty(out)).toEqual([]);
  });
});

function readdirOrEmpty(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

describe('CLI: pnpm backup / pnpm restore (exit codes, output, no password leaks)', () => {
  it('backup + restore with a password-bearing URL: exit 0, last line is the dir, nothing prints the password', () => {
    const cliOut = path.join(WORK, 'cli-out');
    const b = cli('backup', ['--out', cliOut], { BLOG0_DATABASE_URL: withPassword(SRC_URL) });
    expect(b.status, b.stderr).toBe(0);
    const dir = b.stdout.trim().split('\n').at(-1)!;
    expect(path.dirname(dir)).toBe(cliOut);
    expect(existsSync(path.join(dir, 'manifest.json'))).toBe(true);

    const env = { BLOG0_DATABASE_URL: withPassword(SRC_URL) };
    const target = dbNameOf(TARGET_URL);
    const storage = path.join(WORK, 'cli-storage');
    const r = cli('restore', ['--in', dir, '--db', target, '--storage', storage, '--force'], env);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^restore-check: OK \(16 tables, \d+ rows, 2 files\)$/m);

    // again without --force → exit 1 "is not empty"
    const again = cli('restore', ['--in', dir, '--db', target, '--storage', path.join(WORK, 'cli-storage-2')], env);
    expect(again.status).toBe(1);
    expect(again.stderr).toMatch(new RegExp(`^restore failed: ${target} is not empty`, 'm'));

    // --check-only after removing a file → exit 1, files MISMATCH
    rmSync(path.join(storage, mediaKey));
    const check = cli('restore', ['--in', dir, '--db', withPassword(TARGET_URL), '--storage', storage, '--check-only'], {});
    expect(check.status).toBe(1);
    expect(check.stdout).toMatch(/^files +1 \/ 2 MISMATCH$/m);
    expect(check.stdout).toMatch(/^restore-check: FAILED/m);

    for (const run of [b, r, again, check]) {
      expect(run.stdout + run.stderr).not.toContain(PASSWORD);
    }
  });

  it('exit 2 for a pglite:// URL and for an unknown flag; exit 1 without pg_dump on PATH', () => {
    const pglite = cli('backup', ['--out', path.join(WORK, 'cli-x')], { BLOG0_DATABASE_URL: 'pglite://./var/pglite' });
    expect(pglite.status).toBe(2);
    expect(pglite.stderr).toContain(
      'backup failed: backups cover Postgres only — designer data lives in the PGlite directory; copy it while dev:design is stopped',
    );

    const bogus = cli('restore', ['--in', 'x', '--bogus'], {});
    expect(bogus.status).toBe(2);
    expect(bogus.stderr).toMatch(/usage: pnpm restore/);

    // pg_dump is looked up BEFORE any DB connection: a URL whose server is unreachable proves the
    // order (a connect-first CLI would report the connection failure instead).
    mkdirSync(EMPTY_PATH, { recursive: true });
    const unreachable = withPassword('postgres://x@127.0.0.1:1/nothing');
    const noTools = spawnSync(process.execPath, [TSX, 'scripts/backup.ts', '--', '--out', path.join(WORK, 'cli-x')], {
      cwd: ROOT,
      env: { NODE_ENV: 'production', HOME: process.env.HOME ?? '', PATH: EMPTY_PATH, BLOG0_DATABASE_URL: unreachable },
      encoding: 'utf8',
      timeout: 90_000,
    });
    expect(noTools.status).toBe(1);
    expect(noTools.stderr).toContain('backup failed: pg_dump not found on PATH');
    expect(noTools.stderr).not.toContain(PASSWORD);
    expect(readdirOrEmpty(path.join(WORK, 'cli-x'))).toEqual([]);
  });
});
