// Playwright global setup: reset + migrate blog0_test and seed the site row (S1.8 extends it to
// seed the admin). Playwright starts the web server first; the app connects to the DB lazily, so
// resetting the schema here (before any test request) is safe.
import '../../scripts/lib/allow-server-only';

import { closeDb } from '@/server/db/client';
import { resetConfigForTests } from '@/server/config';

import { prepareTestDatabase, resetDb } from '../helpers/db';
import { pointAtTestDatabase } from '../helpers/env';

export default async function globalSetup(): Promise<void> {
  const previousUrl = process.env.BLOG0_DATABASE_URL;
  const testUrl = pointAtTestDatabase();
  try {
    await prepareTestDatabase(testUrl);
    resetConfigForTests();
    await resetDb();
  } finally {
    await closeDb();
    process.env.BLOG0_DATABASE_URL = previousUrl;
    resetConfigForTests();
  }
}
