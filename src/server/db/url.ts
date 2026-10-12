// Database URL → engine (spec/architecture.md §11.1). Pure: no I/O, no `server-only` (scripts,
// next.config-free helpers and unit tests import it directly).
//
//   postgres:// | postgresql://   → server Postgres (the production engine)
//   pglite://<dir>                 → embedded PGlite persisted in <dir> (relative to process.cwd())
//   pglite://memory                → in-memory PGlite (tests/spike; nothing persisted)
//   absent / empty                 → embedded PGlite at ./var/pglite (designer mode default)
//   anything else                  → DatabaseUrlError

export type DbEngine = 'postgres' | 'pglite';

export type ParsedDatabaseUrl =
  | { engine: 'postgres'; url: string }
  | { engine: 'pglite'; dir: string };

/** The designer-mode default (and what an absent BLOG0_DATABASE_URL means). */
export const DEFAULT_PGLITE_DIR = './var/pglite';
export const DEFAULT_PGLITE_URL = `pglite://${DEFAULT_PGLITE_DIR}`;
/** Reserved directory name for an in-memory instance. */
export const PGLITE_MEMORY = 'memory';

export class DatabaseUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseUrlError';
  }
}

/** Trims and strips a trailing ` # comment` (dirty .env tolerance); empty → undefined. */
function clean(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.replace(/\s+#.*$/, '').trim();
  return value === '' ? undefined : value;
}

function isPostgresUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'postgres:' || url.protocol === 'postgresql:') && url.pathname.length > 1;
  } catch {
    return false;
  }
}

/**
 * Parses BLOG0_DATABASE_URL (or another variable named by `name`, used only in messages).
 * Throws DatabaseUrlError with a message that never echoes the URL (it may carry a password).
 */
export function parseDatabaseUrl(raw: string | undefined, name = 'BLOG0_DATABASE_URL'): ParsedDatabaseUrl {
  const value = clean(raw);
  if (value === undefined) return { engine: 'pglite', dir: DEFAULT_PGLITE_DIR };
  if (/^postgres(ql)?:\/\//i.test(value)) {
    if (!isPostgresUrl(value)) throw new DatabaseUrlError(`${name} must be a postgres:// URL with a database name`);
    return { engine: 'postgres', url: value };
  }
  if (/^pglite:\/\//i.test(value)) {
    const dir = value.slice('pglite://'.length).trim();
    if (dir === '') throw new DatabaseUrlError(`${name} must name a directory after pglite:// (e.g. pglite://./var/pglite)`);
    return { engine: 'pglite', dir };
  }
  throw new DatabaseUrlError(`${name} must be postgres:// or pglite:// (e.g. postgres://sai@localhost:5432/blog0_dev or pglite://./var/pglite)`);
}

export function isMemoryPglite(target: ParsedDatabaseUrl): boolean {
  return target.engine === 'pglite' && target.dir === PGLITE_MEMORY;
}

/** A stable identity for caching (never logged for postgres — it may carry a password). */
export function databaseKey(target: ParsedDatabaseUrl): string {
  return target.engine === 'postgres' ? `postgres:${target.url}` : `pglite:${target.dir}`;
}

/** Human-readable, password-free label: `pglite:./var/pglite`, or the postgres database name. */
export function describeDatabase(target: ParsedDatabaseUrl): string {
  if (target.engine === 'pglite') return `pglite:${target.dir}`;
  try {
    return decodeURIComponent(new URL(target.url).pathname.replace(/^\//, ''));
  } catch {
    return 'postgres';
  }
}
