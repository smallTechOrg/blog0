// pnpm db:create — creates the dev and test databases if missing; prints "exists"/"created" per DB.
// On pglite://<dir> (designer mode) it creates the data directory instead (mkdir -p).
import { runCli } from './lib/cli';

import { existsSync, mkdirSync } from 'node:fs';

import { loadDatabaseTarget, loadDatabaseUrl } from '../src/server/config';
import { resolvePgliteDir } from '../src/server/db/pglite';
import { ensurePostgresDatabase } from '../src/server/db/postgres';
import { describeDatabase, PGLITE_MEMORY } from '../src/server/db/url';

runCli('db:create', async () => {
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
  const urls = dev.engine === 'postgres' ? [dev.url] : [];
  if ((process.env.BLOG0_TEST_DATABASE_URL ?? '').trim() !== '') {
    const testUrl = loadDatabaseUrl(process.env, 'BLOG0_TEST_DATABASE_URL');
    const dbId = (url: string) => `${new URL(url).host}/${describeDatabase({ engine: 'postgres', url })}`;
    if (dev.engine === 'postgres' && dbId(testUrl) === dbId(dev.url)) {
      throw new Error('BLOG0_TEST_DATABASE_URL must point at a different database than BLOG0_DATABASE_URL — fix it in .env');
    }
    urls.push(testUrl);
  } else {
    console.log('BLOG0_TEST_DATABASE_URL not set — skipping the test database (set it in .env to run tests)');
  }
  for (const url of urls) {
    console.log(`${describeDatabase({ engine: 'postgres', url })}: ${await ensurePostgresDatabase(url)}`);
  }
});
