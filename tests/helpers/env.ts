// Test environment: loads .env once (via @next/env, never printing values) and resolves the
// dedicated test database URL. Tests refuse to run against the dev database.
import { loadEnvConfig } from '@next/env';

// `@/server/llm/key` imports `server-only`: Vitest aliases it to a no-op (vitest.config.ts); other
// Node-side importers (Playwright) must import scripts/lib/allow-server-only first.
import { isPostgresUrl } from '@/server/db/url';
import { openRouterKeyStatus, realKeyRequired } from '@/server/llm/key';

// Kept on globalThis: Vitest re-evaluates modules per test file inside one worker process, but
// process.env (already pointed at the test DB by an earlier file) persists.
const ORIGINAL_DB_URL = Symbol.for('blog0.tests.originalDatabaseUrl');
type GlobalWithUrl = typeof globalThis & { [ORIGINAL_DB_URL]?: { value: string | undefined } };

/** Loads .env into process.env (existing variables win) and remembers the dev DATABASE_URL. */
export function loadTestEnv(): void {
  const g = globalThis as GlobalWithUrl;
  if (g[ORIGINAL_DB_URL]) return;
  loadEnvConfig(process.cwd(), false, { info: () => {}, error: console.error });
  g[ORIGINAL_DB_URL] = { value: process.env.BLOG0_DATABASE_URL };
}

function dbIdentity(url: string): string {
  const u = new URL(url);
  return `${u.hostname}:${u.port || '5432'}${u.pathname}`;
}

/** BLOG0_TEST_DATABASE_URL, validated: present, postgres://, and not the dev database. */
export function getTestDatabaseUrl(): string {
  loadTestEnv();
  const testUrl = (process.env.BLOG0_TEST_DATABASE_URL ?? '').trim();
  if (testUrl === '') {
    throw new Error('BLOG0_TEST_DATABASE_URL is not set — add it to .env (e.g. postgres://sai@localhost:5432/blog0_test)');
  }
  if (!isPostgresUrl(testUrl)) throw new Error('BLOG0_TEST_DATABASE_URL must be a postgres:// URL');
  const devUrl = ((globalThis as GlobalWithUrl)[ORIGINAL_DB_URL]?.value ?? '').trim();
  if (devUrl !== '' && devUrl !== testUrl && dbIdentity(devUrl) === dbIdentity(testUrl)) {
    throw new Error('BLOG0_TEST_DATABASE_URL points at the same database as BLOG0_DATABASE_URL — tests refuse to run');
  }
  if (devUrl === testUrl) {
    throw new Error('BLOG0_TEST_DATABASE_URL equals BLOG0_DATABASE_URL — tests refuse to run against the dev database');
  }
  return testUrl;
}

/** Points the app at the test database (BLOG0_DATABASE_URL := BLOG0_TEST_DATABASE_URL). */
export function pointAtTestDatabase(): string {
  const testUrl = getTestDatabaseUrl();
  process.env.BLOG0_DATABASE_URL = testUrl;
  return testUrl;
}

/** True only for a plausible real OpenRouter key. Empty and placeholder values
 *  (`pending-placeholder`, `replace-with-…`) count as absent — the PENDING KEY rule in
 *  spec/architecture.md ## Conventions; classification is delegated to `openRouterKeyStatus`. */
export function hasOpenRouterKey(): boolean {
  loadTestEnv();
  return openRouterKeyStatus(process.env.BLOG0_OPENROUTER_API_KEY) === 'real';
}

/** PENDING KEY rule: with no real key, real-key tests SKIP (with a visible `PENDING KEY` reason)
 *  unless `realKeyRequired()` (BLOG0_REQUIRE_REAL_KEY=1, or CI=true when it is unset), where they
 *  must run and FAIL. With a real key they always run. */
export function shouldSkipRealKeyTests(): boolean {
  return !hasOpenRouterKey() && !realKeyRequired(process.env);
}
