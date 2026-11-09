import 'server-only';

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { sql } from 'drizzle-orm';

import { createDbHandle, rowsOf, type DbHandle } from './client';
import { parseDatabaseUrl, type ParsedDatabaseUrl } from './url';

// Programmatic migrator (drizzle-orm, a main dependency → deploy needs no dev tooling). The same
// migration folder and ledger (`drizzle.__drizzle_migrations`) for both engines, applied with the
// engine's own drizzle migrator. Used by `pnpm db:migrate`, `pnpm db:verify`, `pnpm dev:design`
// and the test harnesses.

export const MIGRATIONS_FOLDER = path.join(process.cwd(), 'src', 'server', 'db', 'migrations');
const MIGRATIONS_SCHEMA = 'drizzle';
const MIGRATIONS_TABLE = '__drizzle_migrations';

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

export function readJournal(folder = MIGRATIONS_FOLDER): JournalEntry[] {
  const raw = readFileSync(path.join(folder, 'meta', '_journal.json'), 'utf8');
  const journal = JSON.parse(raw) as { entries: JournalEntry[] };
  return [...journal.entries].sort((a, b) => a.idx - b.idx);
}

/** A URL string, a parsed target (a handle is opened and closed here), or an open handle (left open). */
export type MigrationTarget = string | ParsedDatabaseUrl | DbHandle;

function isHandle(target: MigrationTarget): target is DbHandle {
  return typeof target === 'object' && 'db' in target;
}

async function withHandle<T>(target: MigrationTarget, fn: (handle: DbHandle) => Promise<T>): Promise<T> {
  if (isHandle(target)) return fn(target);
  const parsed = typeof target === 'string' ? parseDatabaseUrl(target) : target;
  const handle = await createDbHandle(parsed, { max: 1 });
  try {
    return await fn(handle);
  } finally {
    await handle.close();
  }
}

async function migrateWith(handle: DbHandle, folder: string): Promise<void> {
  const config = { migrationsFolder: folder, migrationsSchema: MIGRATIONS_SCHEMA, migrationsTable: MIGRATIONS_TABLE };
  if (handle.engine === 'pglite') {
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    await migrate(handle.db as Parameters<typeof migrate>[0], config);
  } else {
    const { migrate } = await import('drizzle-orm/postgres-js/migrator');
    await migrate(handle.db as Parameters<typeof migrate>[0], config);
  }
}

/** Applies every pending migration. Returns the tags applied by this call. */
export async function runMigrations(target: MigrationTarget, folder = MIGRATIONS_FOLDER): Promise<string[]> {
  return withHandle(target, async (handle) => {
    const before = await statusOf(handle, folder);
    await migrateWith(handle, folder);
    return before.pending;
  });
}

export interface MigrationStatus {
  engine: 'postgres' | 'pglite';
  database: string;
  serverVersion: string;
  applied: string[];
  pending: string[];
  latestApplied: string | null;
}

async function statusOf(handle: DbHandle, folder: string): Promise<MigrationStatus> {
  const journal = readJournal(folder);
  const { db } = handle;
  const [meta] = rowsOf<{ database: string; server_version: string }>(
    await db.execute(sql`select current_database() as database, current_setting('server_version') as server_version`),
  );
  const [ledger] = rowsOf<{ exists: boolean }>(
    await db.execute(sql`select to_regclass(${`${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}`}) is not null as exists`),
  );
  let appliedMillis = new Set<number>();
  if (ledger?.exists) {
    const rows = rowsOf<{ created_at: string }>(
      await db.execute(
        sql`select created_at::text as created_at from ${sql.identifier(MIGRATIONS_SCHEMA)}.${sql.identifier(MIGRATIONS_TABLE)}`,
      ),
    );
    appliedMillis = new Set(rows.map((r) => Number(r.created_at)));
  }
  const applied = journal.filter((e) => appliedMillis.has(e.when)).map((e) => e.tag);
  const pending = journal.filter((e) => !appliedMillis.has(e.when)).map((e) => e.tag);
  return {
    engine: handle.engine,
    database: meta.database,
    serverVersion: meta.server_version.split(' ')[0], // "18.1 (Homebrew)" → "18.1"
    applied,
    pending,
    latestApplied: applied.length > 0 ? applied[applied.length - 1] : null,
  };
}

/** Compares the journal with drizzle's ledger table (matched by the journal's `when` timestamp). */
export async function getMigrationStatus(target: MigrationTarget, folder = MIGRATIONS_FOLDER): Promise<MigrationStatus> {
  return withHandle(target, (handle) => statusOf(handle, folder));
}
