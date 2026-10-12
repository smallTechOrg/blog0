// Vitest integration global setup: create blog0_test if missing, drop + recreate its schema, migrate.
import { getTestDatabaseUrl } from '../helpers/env';
import { prepareTestDatabase } from '../helpers/db';

export default async function setup(): Promise<void> {
  const testUrl = getTestDatabaseUrl();
  await prepareTestDatabase(testUrl);
}
