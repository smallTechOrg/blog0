// Vitest integration setup file (runs in every test file's worker before the tests):
// loads .env, points BLOG0_DATABASE_URL at BLOG0_TEST_DATABASE_URL, resets every singleton.
import { afterAll, beforeAll } from 'vitest';

import { resetConfigForTests } from '@/server/config';
import { resetDbForTests } from '@/server/db/client';
import { resetLoggerForTests } from '@/server/log';
import { resetRateLimitStoreForTests } from '@/server/rate-window-store';
import { resetCurrentSiteForTests } from '@/server/site/current';

import { loadTestEnv, pointAtTestDatabase } from '../helpers/env';

loadTestEnv();
pointAtTestDatabase();
// Uploaded files land on a dedicated disk dir (wiped by tests/helpers/storage.ts resetStorage()).
process.env.BLOG0_STORAGE_DIR = 'var/storage-test';
// Throttles count in memory unless a test opts into the DB store explicitly
// (resetRateLimitStoreForTests(new DbRateLimitStore()) — tests/integration/rate-limit-db.test.ts).
process.env.BLOG0_RATE_LIMIT_STORE = 'memory';
// Keep test output readable: info lines still reach captureLogs() sinks, just not stdout.
if ((process.env.BLOG0_LOG_LEVEL ?? '').trim() === '') process.env.BLOG0_LOG_LEVEL = 'warn';

beforeAll(async () => {
  resetConfigForTests();
  resetLoggerForTests();
  resetCurrentSiteForTests();
  resetRateLimitStoreForTests();
  await resetDbForTests();
});

afterAll(async () => {
  await resetDbForTests();
});
