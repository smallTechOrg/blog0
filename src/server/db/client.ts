import 'server-only';

import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { getConfig } from '../config';
import * as schema from './schema';

// postgres.js client + drizzle (spec/architecture.md §2). Lazily created from getConfig();
// cached on globalThis so dev-mode module reloads do not leak connection pools.

export type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type Sql = postgres.Sql;

interface DbState {
  sql: Sql;
  db: Db;
  url: string;
}

const globalKey = Symbol.for('blog0.db');
type GlobalWithDb = typeof globalThis & { [globalKey]?: DbState };

/** Creates a standalone client (scripts, migrations, tests). Caller must `sql.end()`. */
export function createSqlClient(url: string, options: { max?: number } = {}): Sql {
  return postgres(url, {
    max: options.max ?? 10,
    idle_timeout: 20,
    connect_timeout: 5,
    onnotice: () => {},
  });
}

function state(): DbState {
  const g = globalThis as GlobalWithDb;
  const url = getConfig().databaseUrl;
  const existing = g[globalKey];
  if (existing && existing.url === url) return existing;
  if (existing) void existing.sql.end({ timeout: 1 }).catch(() => {});
  const sql = createSqlClient(url);
  const next: DbState = { sql, db: drizzle(sql, { schema }), url };
  g[globalKey] = next;
  return next;
}

export function getDb(): Db {
  return state().db;
}

export function getSql(): Sql {
  return state().sql;
}

/** Closes the pool (scripts/tests). The next getDb() opens a fresh one. */
export async function closeDb(): Promise<void> {
  const g = globalThis as GlobalWithDb;
  const existing = g[globalKey];
  g[globalKey] = undefined;
  if (existing) await existing.sql.end({ timeout: 5 });
}

export async function resetDbForTests(): Promise<void> {
  await closeDb();
}
