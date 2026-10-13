import 'server-only';

import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

import { getConfig } from '../config';
import { openPglite, openPgliteSync } from './pglite';
import { openPostgres } from './postgres';
import type * as schema from './schema';
import { databaseKey, type DbEngine, type ParsedDatabaseUrl } from './url';

// Engine-neutral database access (spec/architecture.md §11.2). The app's handle is created lazily
// from getConfig().database and cached on globalThis, so dev-mode module reloads neither leak
// postgres pools nor open a second PGlite instance on the same directory (PGlite has no dir lock).

/** Both drizzle drivers (postgres-js, pglite) extend this type; services code against it. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Either the app handle or an open transaction: every repo function takes one. */
export type Executor = Db | Tx;

export interface DbHandle {
  db: Db;
  engine: DbEngine;
  /** `select 1` — the health check. */
  ping(): Promise<void>;
  close(): Promise<void>;
}

interface DbState {
  key: string;
  handle: DbHandle;
  ready: Promise<void>;
}

const globalKey = Symbol.for('blog0.db');
type GlobalWithDb = typeof globalThis & { [globalKey]?: DbState };

/** Opens a standalone handle (scripts, migrations, tests). The caller must `close()` it. */
export async function createDbHandle(target: ParsedDatabaseUrl, opts: { max?: number } = {}): Promise<DbHandle> {
  if (target.engine === 'postgres') return openPostgres(target.url, opts);
  return openPglite(target.dir);
}

/**
 * Result rows of `db.execute(...)` on either driver: postgres-js returns the row array itself,
 * pglite returns `{ rows, fields, affectedRows }`.
 */
export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

function state(): DbState {
  const g = globalThis as GlobalWithDb;
  const target = getConfig().database;
  const key = databaseKey(target);
  const existing = g[globalKey];
  if (existing && existing.key === key) return existing;
  if (existing) void existing.handle.close().catch(() => {});
  let next: DbState;
  if (target.engine === 'postgres') {
    next = { key, handle: openPostgres(target.url), ready: Promise.resolve() };
  } else {
    const handle = openPgliteSync(target.dir);
    next = { key, handle, ready: handle.ready };
  }
  g[globalKey] = next;
  return next;
}

/** The app's handle for the configured engine (one per process; health check, scripts). */
export function getDbHandle(): DbHandle {
  return state().handle;
}

/** Unchanged signature: every service keeps calling getDb(). */
export function getDb(): Db {
  return state().handle.db;
}

/** Opens the configured database and waits until it is ready (instrumentation's register()). */
export async function initDb(): Promise<DbHandle> {
  const s = state();
  await s.ready;
  return s.handle;
}

/** Closes the app's handle (scripts/tests/shutdown). The next getDb() opens a fresh one. */
export async function closeDb(): Promise<void> {
  const g = globalThis as GlobalWithDb;
  const existing = g[globalKey];
  g[globalKey] = undefined;
  if (existing) await existing.handle.close();
}

export async function resetDbForTests(): Promise<void> {
  await closeDb();
}
