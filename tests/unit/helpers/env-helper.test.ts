import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hasOpenRouterKey, shouldSkipRealKeyTests } from '../../helpers/env';

// PENDING KEY rule (spec/architecture.md ## Conventions): a missing or placeholder key counts as
// absent; absent → real-key tests skip, unless a real key is required (BLOG0_REQUIRE_REAL_KEY=1, or
// CI=true when that flag is unset) — then they must run (and fail).

const KEYS = ['BLOG0_OPENROUTER_API_KEY', 'CI', 'BLOG0_REQUIRE_REAL_KEY'] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function setEnv(key: string | undefined, ci: string | undefined, requireRealKey?: string): void {
  if (key === undefined) delete process.env.BLOG0_OPENROUTER_API_KEY;
  else process.env.BLOG0_OPENROUTER_API_KEY = key;
  if (ci === undefined) delete process.env.CI;
  else process.env.CI = ci;
  if (requireRealKey === undefined) delete process.env.BLOG0_REQUIRE_REAL_KEY;
  else process.env.BLOG0_REQUIRE_REAL_KEY = requireRealKey;
}

describe('hasOpenRouterKey', () => {
  it('is true for a plausible real key', () => {
    setEnv('sk-or-v1-0123456789abcdef', undefined);

    expect(hasOpenRouterKey()).toBe(true);
  });

  it('treats empty, pending-placeholder and replace-with-* values as absent', () => {
    for (const value of ['', '   ', 'pending-placeholder', 'replace-with-your-openrouter-key']) {
      setEnv(value, undefined);

      expect(hasOpenRouterKey()).toBe(false);
    }
  });
});

describe('shouldSkipRealKeyTests', () => {
  it('skips locally when the key is a placeholder', () => {
    setEnv('pending-placeholder', undefined);

    expect(shouldSkipRealKeyTests()).toBe(true);
  });

  it('does not skip on CI=true without a key, so the real-key tests fail', () => {
    setEnv('replace-with-your-openrouter-key', 'true');

    expect(shouldSkipRealKeyTests()).toBe(false);
  });

  it('never skips when a real key is present, locally or on CI', () => {
    setEnv('sk-or-v1-0123456789abcdef', undefined);
    expect(shouldSkipRealKeyTests()).toBe(false);

    setEnv('sk-or-v1-0123456789abcdef', 'true');
    expect(shouldSkipRealKeyTests()).toBe(false);
  });

  it('BLOG0_REQUIRE_REAL_KEY=1 makes a placeholder key run (and fail) even outside CI', () => {
    setEnv('pending-placeholder', undefined, '1');

    expect(shouldSkipRealKeyTests()).toBe(false);
  });

  it('BLOG0_REQUIRE_REAL_KEY=0 skips a placeholder key even with CI=true (no secret on a fork PR)', () => {
    setEnv('pending-placeholder', 'true', '0');

    expect(shouldSkipRealKeyTests()).toBe(true);
  });

  it('BLOG0_REQUIRE_REAL_KEY=0 never skips when a real key is present', () => {
    setEnv('sk-or-v1-0123456789abcdef', 'true', '0');

    expect(shouldSkipRealKeyTests()).toBe(false);
  });
});
