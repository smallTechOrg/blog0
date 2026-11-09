// GCP deploy (spec/architecture.md §12.7): the release step, connected as the schema owner, ensures
// the restricted runtime role BLOG0_APP_DB_ROLE (silverwave's split) — row privileges only, owns
// nothing. Real Postgres in its OWN database (BLOG0_TEST_DATABASE_URL suffixed `_approle`) and a
// per-run role name (roles are cluster-wide), dropped in afterAll. Proves: created → updated on a
// re-run, the role can read/write rows and read drizzle's ledger (readiness), and can never
// DROP / TRUNCATE / ALTER / CREATE; tables the owner creates later are covered by default privileges;
// both-or-neither validation happens before any DB work; the password never reaches the output.
import { randomBytes } from 'node:crypto';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ensurePostgresDatabase } from '@/server/db/postgres';
import { AppRoleError, appRoleFromEnv } from '@/server/ops/app-role';
import { runRelease } from '@/server/ops/release';

import { getTestDatabaseUrl } from '../helpers/env';

function ownerUrl(): string {
  const url = new URL(getTestDatabaseUrl());
  url.pathname = `${url.pathname}_approle`;
  return url.toString();
}
const OWNER_URL = ownerUrl();
const ROLE = `blog0_app_it_${randomBytes(4).toString('hex')}`;
const PASSWORD = `pw-${randomBytes(12).toString('hex')}`;

function appUrl(): string {
  const url = new URL(OWNER_URL);
  url.username = ROLE;
  url.password = PASSWORD;
  return url.toString();
}

const owner = () => postgres(OWNER_URL, { max: 1, connect_timeout: 5, onnotice: () => {} });

async function release(extra: Record<string, string | undefined> = {}): Promise<string[]> {
  const lines: string[] = [];
  await runRelease({
    env: { BLOG0_DATABASE_URL: OWNER_URL, BLOG0_APP_DB_ROLE: ROLE, BLOG0_APP_DB_PASSWORD: PASSWORD, ...extra },
    slug: 'blog0',
    out: (line) => lines.push(line),
  });
  return lines;
}

/** Runs `statement` as the app role; returns null on success or the Postgres error message. */
async function asApp(statement: string): Promise<string | null> {
  const sql = postgres(appUrl(), { max: 1, connect_timeout: 5, onnotice: () => {} });
  try {
    await sql.unsafe(statement);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

beforeAll(async () => {
  await ensurePostgresDatabase(OWNER_URL);
  const sql = owner();
  try {
    await sql.unsafe('drop schema if exists drizzle cascade; drop schema if exists public cascade; create schema public;');
  } finally {
    await sql.end({ timeout: 5 });
  }
}, 60_000);

afterAll(async () => {
  const sql = owner();
  try {
    const [exists] = await sql`select 1 as ok from pg_roles where rolname = ${ROLE}`;
    if (exists) await sql.unsafe(`drop owned by "${ROLE}"; drop role "${ROLE}"`);
  } finally {
    await sql.end({ timeout: 5 });
  }
});

describe('release + BLOG0_APP_DB_ROLE (restricted runtime role)', () => {
  it('creates the role after the migrations, then reports "updated" on a re-run; the password is never printed', async () => {
    const first = await release();
    expect(first.join('\n')).toMatch(/0 pending: OK/);
    expect(first).toContain(`app role ${ROLE} ok (created)`);
    const second = await release();
    expect(second).toContain(`app role ${ROLE} ok (updated)`);
    expect([...first, ...second].join('\n')).not.toContain(PASSWORD);

    const sql = owner();
    try {
      const [r] = await sql<{ rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean; rolcanlogin: boolean }[]>`
        select rolsuper, rolcreatedb, rolcreaterole, rolcanlogin from pg_roles where rolname = ${ROLE}`;
      expect(r).toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolcanlogin: true });
      const owned = await sql`select 1 from pg_class c join pg_roles r on r.oid = c.relowner where r.rolname = ${ROLE}`;
      expect(owned.length).toBe(0);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 120_000);

  it('can read and write rows and read the migration ledger', async () => {
    expect(await asApp('select count(*) from site')).toBeNull();
    expect(await asApp("update site set brand_name = brand_name where slug = 'blog0'")).toBeNull();
    expect(await asApp('select count(*) from drizzle.__drizzle_migrations')).toBeNull();
    expect(await asApp("delete from site where slug = 'no-such-site'")).toBeNull();
  }, 60_000);

  it('can never DROP, TRUNCATE, ALTER or CREATE (owner-only operations)', async () => {
    expect(await asApp('drop table site')).toMatch(/must be (the )?owner/);
    expect(await asApp('truncate site')).toMatch(/permission denied/);
    expect(await asApp('alter table site add column x int')).toMatch(/must be (the )?owner/);
    expect(await asApp('create table app_role_probe (id int)')).toMatch(/permission denied/);
    expect(await asApp('delete from drizzle.__drizzle_migrations')).toMatch(/permission denied/);
  }, 60_000);

  it('covers tables the owner creates later (default privileges), without a re-grant', async () => {
    const sql = owner();
    try {
      await sql.unsafe('create table later_table (id serial primary key, v text)');
    } finally {
      await sql.end({ timeout: 5 });
    }
    expect(await asApp("insert into later_table (v) values ('x')")).toBeNull();
    expect(await asApp('select * from later_table')).toBeNull();
    expect(await asApp('drop table later_table')).toMatch(/must be (the )?owner/);
  }, 60_000);

  it('validates both-or-neither before touching the database, without echoing the password', async () => {
    expect(appRoleFromEnv({})).toBeNull();
    expect(() => appRoleFromEnv({ BLOG0_APP_DB_ROLE: 'blog0_app' })).toThrow(AppRoleError);
    expect(() => appRoleFromEnv({ BLOG0_APP_DB_PASSWORD: 'x'.repeat(20) })).toThrow(/set together/);
    expect(() => appRoleFromEnv({ BLOG0_APP_DB_ROLE: 'Bad-Name', BLOG0_APP_DB_PASSWORD: 'x'.repeat(20) })).toThrow(/identifier/);
    expect(() => appRoleFromEnv({ BLOG0_APP_DB_ROLE: 'blog0_app', BLOG0_APP_DB_PASSWORD: 'short' })).toThrow(/16 characters/);
    // An unreachable database is never contacted: the validation error comes first.
    await expect(
      runRelease({ env: { BLOG0_DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none', BLOG0_APP_DB_ROLE: 'blog0_app' }, slug: 'blog0', out: () => {} }),
    ).rejects.toThrow(/set together/);
  });

  it('works when the owner is NOT a superuser (Cloud SQL: blog0_owner has CREATEROLE only): created, then updated', async () => {
    const suffix = randomBytes(4).toString('hex');
    const ownerRole = `blog0_owner_it_${suffix}`;
    const ownerPassword = `pw-${randomBytes(12).toString('hex')}`;
    const appRole = `blog0_app_ns_${suffix}`;
    const dbName = `${new URL(OWNER_URL).pathname.slice(1)}_ns_${suffix}`;
    const admin = owner(); // the test cluster's (super)user
    const toDb = (user: string, password: string) => {
      const url = new URL(OWNER_URL);
      url.pathname = `/${dbName}`;
      url.username = user;
      url.password = password;
      return url.toString();
    };
    try {
      await admin.unsafe(`create role "${ownerRole}" login createrole password '${ownerPassword}'`);
      await admin.unsafe(`create database "${dbName}" owner "${ownerRole}"`);
      const run = async () => {
        const lines: string[] = [];
        await runRelease({
          env: { BLOG0_DATABASE_URL: toDb(ownerRole, ownerPassword), BLOG0_APP_DB_ROLE: appRole, BLOG0_APP_DB_PASSWORD: PASSWORD },
          slug: 'blog0',
          out: (line) => lines.push(line),
        });
        return lines;
      };
      expect(await run()).toContain(`app role ${appRole} ok (created)`);
      expect(await run()).toContain(`app role ${appRole} ok (updated)`);
      const asNs = postgres(toDb(appRole, PASSWORD), { max: 1, connect_timeout: 5, onnotice: () => {} });
      try {
        await asNs`select count(*) from site`;
        await expect(asNs.unsafe('drop table site')).rejects.toThrow(/must be (the )?owner/);
      } finally {
        await asNs.end({ timeout: 5 });
      }
    } finally {
      await admin.unsafe(`drop database if exists "${dbName}" with (force)`);
      await admin.unsafe(`drop role if exists "${appRole}"`);
      await admin.unsafe(`drop role if exists "${ownerRole}"`);
      await admin.end({ timeout: 5 });
    }
  }, 120_000);

  it('refuses the owner itself as the app role', async () => {
    const ownerName = decodeURIComponent(new URL(OWNER_URL).username) || process.env.USER || '';
    if (!/^[a-z_][a-z0-9_]*$/.test(ownerName)) return; // owner from a socket default: nothing to assert
    await expect(release({ BLOG0_APP_DB_ROLE: ownerName })).rejects.toThrow(/must differ/);
  }, 60_000);
});
