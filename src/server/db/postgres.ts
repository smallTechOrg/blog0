import 'server-only';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import type { Db, DbHandle } from './client';
import * as schema from './schema';

// Server Postgres engine (the production engine): postgres.js pool + drizzle.

/** Opens a postgres.js pool. `max` defaults to 10 (the app); scripts pass 1. Caller closes. */
export function openPostgres(url: string, options: { max?: number } = {}): DbHandle {
  const client = postgres(url, {
    max: options.max ?? 10,
    idle_timeout: 20,
    connect_timeout: 5,
    onnotice: () => {},
  });
  const db: Db = drizzle(client, { schema });
  return {
    db,
    engine: 'postgres',
    async ping() {
      await client`select 1 as ok`;
    },
    async close() {
      await client.end({ timeout: 5 });
    },
  };
}

/** Creates the URL's database (via the `postgres` maintenance DB) when it does not exist yet. */
export async function ensurePostgresDatabase(url: string): Promise<'exists' | 'created'> {
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  const maintenance = new URL(url);
  maintenance.pathname = '/postgres';
  const sql = postgres(maintenance.toString(), { max: 1, connect_timeout: 5, onnotice: () => {} });
  try {
    if ((await sql`select 1 from pg_database where datname = ${name}`).length > 0) return 'exists';
    await sql.unsafe(`create database "${name.replace(/"/g, '""')}"`);
    return 'created';
  } finally {
    await sql.end({ timeout: 5 });
  }
}
