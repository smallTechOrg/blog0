// Vitest integration setup file (runs in every test file's worker before the tests):
// loads .env, points BLOG0_DATABASE_URL at BLOG0_TEST_DATABASE_URL, resets every singleton.
import { afterAll, beforeAll } from 'vitest';

import { resetConfigForTests } from '@/server/config';
import { resetDbForTests } from '@/server/db/client';
import { resetLoggerForTests } from '@/server/log';
import { resetMailTransportForTests } from '@/server/newsletter/mail/transport';
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
// Phase 7: the stub sender + the recording stub mail transport — tests never need SMTP or Listmonk.
// (The Listmonk tests set BLOG0_NEWSLETTER_SENDER=listmonk themselves from var/listmonk-test.env — the
// test stack, whose only SMTP is Mailpit; they refuse any instance with a real relay.)
process.env.BLOG0_NEWSLETTER_SENDER = 'stub';
process.env.BLOG0_SMTP_HOST = '';
// Keep test output readable: info lines still reach captureLogs() sinks, just not stdout.
if ((process.env.BLOG0_LOG_LEVEL ?? '').trim() === '') process.env.BLOG0_LOG_LEVEL = 'warn';

beforeAll(async () => {
  resetConfigForTests();
  resetLoggerForTests();
  resetCurrentSiteForTests();
  resetRateLimitStoreForTests();
  resetMailTransportForTests();
  await resetDbForTests();
});

afterAll(async () => {
  await resetDbForTests();
});
