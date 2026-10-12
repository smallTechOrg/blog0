import 'server-only';

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

import { createSqlClient } from './client';

// Programmatic migrator (drizzle-orm, a main dependency → deploy needs no dev tooling).
// Used by `pnpm db:migrate`, `pnpm db:verify` and the test harnesses.

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

/** Applies every pending migration to `url`. Returns the tags applied by this call. */
export async function runMigrations(url: string, folder = MIGRATIONS_FOLDER): Promise<string[]> {
  const before = await getMigrationStatus(url, folder);
  const sql = createSqlClient(url, { max: 1 });
  try {
    await migrate(drizzle(sql), {
      migrationsFolder: folder,
      migrationsSchema: MIGRATIONS_SCHEMA,
      migrationsTable: MIGRATIONS_TABLE,
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
  return before.pending;
}

export interface MigrationStatus {
  database: string;
  serverVersion: string;
  applied: string[];
  pending: string[];
  latestApplied: string | null;
}

/** Compares the journal with drizzle's ledger table (matched by the journal's `when` timestamp). */
export async function getMigrationStatus(url: string, folder = MIGRATIONS_FOLDER): Promise<MigrationStatus> {
  const journal = readJournal(folder);
  const sql = createSqlClient(url, { max: 1 });
  try {
    const [meta] = await sql<{ database: string; server_version: string }[]>`
      select current_database() as database, current_setting('server_version') as server_version`;
    const [ledger] = await sql<{ exists: boolean }[]>`
      select to_regclass(${`${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}`}) is not null as exists`;
    let appliedMillis = new Set<number>();
    if (ledger?.exists) {
      const rows = await sql<{ created_at: string }[]>`
        select created_at::text as created_at from ${sql(MIGRATIONS_SCHEMA)}.${sql(MIGRATIONS_TABLE)}`;
      appliedMillis = new Set(rows.map((r) => Number(r.created_at)));
    }
    const applied = journal.filter((e) => appliedMillis.has(e.when)).map((e) => e.tag);
    const pending = journal.filter((e) => !appliedMillis.has(e.when)).map((e) => e.tag);
    return {
      database: meta.database,
      serverVersion: meta.server_version.split(' ')[0], // "18.1 (Homebrew)" → "18.1"
      applied,
      pending,
      latestApplied: applied.length > 0 ? applied[applied.length - 1] : null,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
