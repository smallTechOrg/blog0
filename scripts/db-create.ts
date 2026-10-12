// pnpm db:create — creates the dev and test databases if missing; prints "exists"/"created" per DB.
// On pglite://<dir> (designer mode) it creates the data directory instead (mkdir -p).
import './lib/allow-server-only';

import { existsSync, mkdirSync } from 'node:fs';

import { loadEnvConfig } from '@next/env';
import postgres from 'postgres';

import { loadDatabaseTarget, loadDatabaseUrl } from '../src/server/config';
import { resolvePgliteDir } from '../src/server/db/pglite';
import { PGLITE_MEMORY } from '../src/server/db/url';

function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

function maintenanceUrl(url: string): string {
  const u = new URL(url);
  u.pathname = '/postgres';
  return u.toString();
}

async function ensureDatabase(url: string): Promise<'exists' | 'created'> {
  const name = databaseName(url);
  const sql = postgres(maintenanceUrl(url), { max: 1, connect_timeout: 5, onnotice: () => {} });
  try {
    const rows = await sql`select 1 from pg_database where datname = ${name}`;
    if (rows.length > 0) return 'exists';
    await sql.unsafe(`create database "${name.replace(/"/g, '""')}"`);
    return 'created';
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main(): Promise<void> {
  loadEnvConfig(process.cwd(), false, { info: () => {}, error: console.error });
  const dev = loadDatabaseTarget(process.env, 'BLOG0_DATABASE_URL');
  if (dev.engine === 'pglite') {
    if (dev.dir === PGLITE_MEMORY) {
      console.log('pglite:memory: nothing to create (in-memory)');
    } else {
      const dir = resolvePgliteDir(dev.dir);
      const existed = existsSync(dir);
      mkdirSync(dir, { recursive: true });
      console.log(`pglite:${dev.dir}: ${existed ? 'exists' : 'created'}`);
    }
  }
  const devUrl = dev.engine === 'postgres' ? dev.url : null;
  const targets: Array<[string, string]> = devUrl === null ? [] : [['BLOG0_DATABASE_URL', devUrl]];
  if ((process.env.BLOG0_TEST_DATABASE_URL ?? '').trim() !== '') {
    const testUrl = loadDatabaseUrl(process.env, 'BLOG0_TEST_DATABASE_URL');
    if (devUrl !== null && databaseName(testUrl) === databaseName(devUrl) && new URL(testUrl).host === new URL(devUrl).host) {
      throw new Error('BLOG0_TEST_DATABASE_URL must point at a different database than BLOG0_DATABASE_URL — fix it in .env');
    }
    targets.push(['BLOG0_TEST_DATABASE_URL', testUrl]);
  } else {
    console.log('BLOG0_TEST_DATABASE_URL not set — skipping the test database (set it in .env to run tests)');
  }
  for (const [, url] of targets) {
    const result = await ensureDatabase(url);
    console.log(`${databaseName(url)}: ${result}`);
  }
}

main().catch((error: unknown) => {
  console.error(`db:create failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
