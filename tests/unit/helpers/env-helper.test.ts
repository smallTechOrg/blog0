import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hasOpenRouterKey, shouldSkipRealKeyTests } from '../../helpers/env';

// PENDING KEY rule (spec/architecture.md ## Conventions): a missing or placeholder key counts as
// absent; absent → real-key tests skip locally, but with CI=true they must run (and fail).

const KEYS = ['BLOG0_OPENROUTER_API_KEY', 'CI'] as const;
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

function setEnv(key: string | undefined, ci: string | undefined): void {
  if (key === undefined) delete process.env.BLOG0_OPENROUTER_API_KEY;
  else process.env.BLOG0_OPENROUTER_API_KEY = key;
  if (ci === undefined) delete process.env.CI;
  else process.env.CI = ci;
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
});
