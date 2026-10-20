import 'server-only';

import type postgres from 'postgres';

// The restricted runtime role (GCP deploy, spec/architecture.md §12.7 — the smallTechOrg/silverwave
// split): migrations run as the schema owner (release step, `BLOG0_DATABASE_URL` = owner); the live
// app and the scheduler connect as a role that owns nothing and holds only row privileges, so a
// compromised or buggy app process can never DROP / TRUNCATE / ALTER anything. The release step calls
// ensureAppRole() after the migrations when BLOG0_APP_DB_ROLE + BLOG0_APP_DB_PASSWORD are set.
// Idempotent: creates the role when missing, (re)sets its password (rotation = change the secret and
// re-run), re-grants on every run, and sets default privileges for tables/sequences the owner creates
// later. Never prints the password. The owner need NOT be a superuser (Cloud SQL's is not): only CREATEROLE
// (+ the ADMIN option it receives on roles it creates) — so an existing role is altered with `login
// password` only (naming NOSUPERUSER/NOCREATEDB/NOREPLICATION in an ALTER needs those attributes), and a
// role that already carries an elevated attribute is refused rather than silently kept.

export const APP_ROLE_RE = /^[a-z_][a-z0-9_]{0,62}$/;
/** Schemas the app reads/writes: `public` (every table) and `drizzle` (readiness reads the ledger). */
const SCHEMAS = ['public', 'drizzle'] as const;

export class AppRoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppRoleError';
  }
}

export interface AppRoleSettings {
  role: string;
  password: string;
}

const present = (value: string | undefined): boolean => (value ?? '').trim() !== '';

/** BLOG0_APP_DB_ROLE + BLOG0_APP_DB_PASSWORD: both or neither (validated before any DB work). */
export function appRoleFromEnv(env: Record<string, string | undefined>): AppRoleSettings | null {
  const role = (env.BLOG0_APP_DB_ROLE ?? '').replace(/\s+#.*$/, '').trim();
  const password = (env.BLOG0_APP_DB_PASSWORD ?? '').trim();
  if (!present(role) && !present(password)) return null;
  if (!present(role) || !present(password)) {
    throw new AppRoleError('BLOG0_APP_DB_ROLE and BLOG0_APP_DB_PASSWORD must be set together');
  }
  if (!APP_ROLE_RE.test(role)) throw new AppRoleError('BLOG0_APP_DB_ROLE must be a lowercase SQL identifier (e.g. blog0_app)');
  if (password.length < 16) throw new AppRoleError('BLOG0_APP_DB_PASSWORD must be at least 16 characters');
  return { role, password };
}

const ident = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const literal = (value: string): string => `'${value.replace(/'/g, "''")}'`;

export type AppRoleStatus = 'created' | 'updated';

/**
 * Ensures `settings.role` as a restricted LOGIN role on the connected database, granted row
 * privileges on every table/sequence of `public` and read access to drizzle's ledger. `sql` must be
 * connected as the schema owner (the role that runs the migrations). Refuses when the role is the
 * connected user itself or already owns objects / has elevated attributes it cannot drop.
 */
export async function ensureAppRole(sql: postgres.Sql, settings: AppRoleSettings): Promise<AppRoleStatus> {
  const { role, password } = settings;
  if (!APP_ROLE_RE.test(role)) throw new AppRoleError('invalid app role name');
  const [{ owner, db }] = await sql<{ owner: string; db: string }[]>`select current_user as owner, current_database() as db`;
  if (owner === role) throw new AppRoleError('BLOG0_APP_DB_ROLE must differ from the migration (owner) user');

  const [existing] = await sql<
    { rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean; rolreplication: boolean; rolbypassrls: boolean }[]
  >`select rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls from pg_roles where rolname = ${role}`;
  if (existing?.rolsuper) throw new AppRoleError(`role ${role} is a superuser — refusing to use it as the restricted app role`);
  if (existing && (existing.rolcreatedb || existing.rolcreaterole || existing.rolreplication || existing.rolbypassrls)) {
    throw new AppRoleError(
      `role ${role} has elevated attributes (CREATEDB/CREATEROLE/REPLICATION/BYPASSRLS) — refusing to use it as the restricted app role`,
    );
  }
  const status: AppRoleStatus = existing ? 'updated' : 'created';

  const r = ident(role);
  const o = ident(owner);
  const statements: string[] = [
    existing
      ? `alter role ${r} with login password ${literal(password)}`
      : `create role ${r} with login nosuperuser nocreatedb nocreaterole noreplication password ${literal(password)}`,
    `grant connect on database ${ident(db)} to ${r}`,
  ];
  for (const schema of SCHEMAS) {
    const [found] = await sql<{ ok: number }[]>`select 1 as ok from pg_namespace where nspname = ${schema}`;
    if (!found) continue;
    const s = ident(schema);
    statements.push(`grant usage on schema ${s} to ${r}`);
    if (schema === 'public') {
      statements.push(
        `grant select, insert, update, delete on all tables in schema ${s} to ${r}`,
        `grant usage, select on all sequences in schema ${s} to ${r}`,
        `alter default privileges for role ${o} in schema ${s} grant select, insert, update, delete on tables to ${r}`,
        `alter default privileges for role ${o} in schema ${s} grant usage, select on sequences to ${r}`,
      );
    } else {
      // drizzle's ledger: read-only (GET /api/health/ready compares it with the journal).
      statements.push(`grant select on all tables in schema ${s} to ${r}`);
    }
  }
  await sql.begin(async (tx) => {
    for (const statement of statements) await tx.unsafe(statement);
  });
  return status;
}
