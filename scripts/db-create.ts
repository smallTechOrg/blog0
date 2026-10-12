// pnpm db:create — creates the dev and test databases if missing; prints "exists"/"created" per DB.
import './lib/allow-server-only';

import { loadEnvConfig } from '@next/env';
import postgres from 'postgres';

import { loadDatabaseUrl } from '../src/server/config';

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
  const devUrl = loadDatabaseUrl(process.env, 'BLOG0_DATABASE_URL');
  const targets: Array<[string, string]> = [['BLOG0_DATABASE_URL', devUrl]];
  if ((process.env.BLOG0_TEST_DATABASE_URL ?? '').trim() !== '') {
    const testUrl = loadDatabaseUrl(process.env, 'BLOG0_TEST_DATABASE_URL');
    if (databaseName(testUrl) === databaseName(devUrl) && new URL(testUrl).host === new URL(devUrl).host) {
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
