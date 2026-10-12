// Vitest integration setup file (runs in every test file's worker before the tests):
// loads .env, points BLOG0_DATABASE_URL at BLOG0_TEST_DATABASE_URL, resets every singleton.
import { afterAll, beforeAll } from 'vitest';

import { resetConfigForTests } from '@/server/config';
import { resetDbForTests } from '@/server/db/client';
import { resetLoggerForTests } from '@/server/log';
import { resetCurrentSiteForTests } from '@/server/site/current';

import { loadTestEnv, pointAtTestDatabase } from '../helpers/env';

loadTestEnv();
pointAtTestDatabase();
// Keep test output readable: info lines still reach captureLogs() sinks, just not stdout.
if ((process.env.BLOG0_LOG_LEVEL ?? '').trim() === '') process.env.BLOG0_LOG_LEVEL = 'warn';

beforeAll(async () => {
  resetConfigForTests();
  resetLoggerForTests();
  resetCurrentSiteForTests();
  await resetDbForTests();
});

afterAll(async () => {
  await resetDbForTests();
});
