// Playwright global setup (spec/architecture.md → Test wiring): reset + migrate blog0_test, seed the
// site row and the admin through src/server/seed/admin.ts. Playwright starts the web server first;
// the app connects to the DB lazily, so resetting the schema here (before any test request) is safe.
//
// Admin credentials: BLOG0_ADMIN_EMAIL + BLOG0_ADMIN_PASSWORD when both are set (from the shell or
// .env, validated like `pnpm db:seed`); otherwise a test-only admin is generated in-process. Either
// way they reach the test workers as BLOG0_E2E_ADMIN_* (workers inherit process.env after global
// setup). The password is never printed.
import '../../scripts/lib/allow-server-only';

import { randomBytes } from 'node:crypto';

import { closeDb, getDb } from '@/server/db/client';
import { resetConfigForTests } from '@/server/config';
import { adminCredentialsFromEnv, seedAdmin, type AdminCredentials } from '@/server/seed/admin';

import { prepareTestDatabase, resetDb } from '../helpers/db';
import { pointAtTestDatabase } from '../helpers/env';
import { E2E_ADMIN_ENV } from './helpers/admin';

function e2eAdminCredentials(): AdminCredentials {
  const email = (process.env.BLOG0_ADMIN_EMAIL ?? '').trim();
  const password = process.env.BLOG0_ADMIN_PASSWORD ?? '';
  if (email !== '' && password.trim() !== '') return adminCredentialsFromEnv(process.env);
  return {
    email: 'e2e-admin@example.test',
    password: `e2e-${randomBytes(18).toString('base64url')}`,
    displayName: 'E2E Writer',
  };
}

export default async function globalSetup(): Promise<void> {
  const previousUrl = process.env.BLOG0_DATABASE_URL;
  const testUrl = pointAtTestDatabase();
  try {
    await prepareTestDatabase(testUrl);
    resetConfigForTests();
    const site = await resetDb();
    const credentials = e2eAdminCredentials();
    await seedAdmin(getDb(), site.id, credentials, { resetPassword: true });
    process.env[E2E_ADMIN_ENV.email] = credentials.email;
    process.env[E2E_ADMIN_ENV.password] = credentials.password;
    process.env[E2E_ADMIN_ENV.name] = credentials.displayName;
  } finally {
    await closeDb();
    if (previousUrl === undefined) delete process.env.BLOG0_DATABASE_URL;
    else process.env.BLOG0_DATABASE_URL = previousUrl;
    resetConfigForTests();
  }
}
