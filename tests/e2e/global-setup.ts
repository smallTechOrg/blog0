// Playwright global setup (spec/architecture.md → Test wiring): reset + migrate blog0_test, seed the
// site row and the admin through src/server/seed/admin.ts, then (Phase 2, S2.9) the 5 design
// articles (seedPosts) and their decks from the committed fixture (seedTldr source 'fixture'), so
// the reader walk makes 0 LLM calls. Phase 3 (S3.6): the server's storage dir (var/storage-e2e,
// BLOG0_STORAGE_DIR in playwright.config.ts) is emptied first, so stored media match the fresh DB. Playwright starts the web server first; the app connects to
// the DB lazily, so resetting the schema here (before any test request) is safe.
//
// Admin credentials: BLOG0_ADMIN_EMAIL + BLOG0_ADMIN_PASSWORD when both are set (from the shell or
// .env, validated like `pnpm db:seed`); otherwise a test-only admin is generated in-process. Either
// way they reach the test workers as BLOG0_E2E_ADMIN_* (workers inherit process.env after global
// setup). The password is never printed.
import '../../scripts/lib/allow-server-only';

import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import { closeDb, getDb } from '@/server/db/client';
import { resetConfigForTests } from '@/server/config';
import { adminCredentialsFromEnv, seedAdmin, type AdminCredentials } from '@/server/seed/admin';
import { seedPosts } from '@/server/seed/seed-posts';
import { seedTldr } from '@/server/seed/seed-tldr';

import { prepareTestDatabase, resetDb } from '../helpers/db';
import { pointAtTestDatabase } from '../helpers/env';
import { E2E_ADMIN_ENV } from './helpers/admin';
import { E2E_STORAGE_DIR } from './helpers/upload';

/** Empties the E2E server's storage dir (S3.6) — guarded so only a var/storage-e2e dir is ever wiped. */
function wipeE2eStorage(): void {
  const dir = path.resolve(process.cwd(), E2E_STORAGE_DIR);
  if (!/[\\/]var[\\/]storage-e2e$/.test(dir)) throw new Error(`refusing to wipe ${dir}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

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
    wipeE2eStorage();
    await prepareTestDatabase(testUrl);
    resetConfigForTests();
    const site = await resetDb();
    const credentials = e2eAdminCredentials();
    const admin = await seedAdmin(getDb(), site.id, credentials, { resetPassword: true });
    const posts = await seedPosts(getDb(), site.id, admin.userId);
    if (posts.created.length !== 5) throw new Error(`E2E seed: expected 5 posts created, got ${posts.created.length}`);
    const decks = await seedTldr(getDb(), site.id, admin.userId, { source: 'fixture' });
    if (decks.seeded.length !== 5 || decks.calls !== 0 || decks.failed.length > 0) {
      throw new Error(`E2E seed: expected 5 fixture decks with 0 calls, got ${decks.seeded.length} (failed: ${decks.failed.join(', ') || 'none'}, calls: ${decks.calls})`);
    }
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
