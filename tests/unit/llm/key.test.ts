import { describe, expect, it } from 'vitest';

import { realKeyRequired } from '@/server/llm/key';

// PENDING KEY rule (spec/architecture.md → Conventions → Real-key tests): BLOG0_REQUIRE_REAL_KEY
// decides fail-vs-skip for a missing/placeholder key; unset (or any other value) falls back to CI.

describe('realKeyRequired', () => {
  it('is true when BLOG0_REQUIRE_REAL_KEY=1, even outside CI', () => {
    expect(realKeyRequired({ BLOG0_REQUIRE_REAL_KEY: '1' })).toBe(true);
    expect(realKeyRequired({ BLOG0_REQUIRE_REAL_KEY: ' 1 ', CI: 'false' })).toBe(true);
  });

  it('is false when BLOG0_REQUIRE_REAL_KEY=0, even with CI=true (fork PR without the secret)', () => {
    expect(realKeyRequired({ BLOG0_REQUIRE_REAL_KEY: '0', CI: 'true' })).toBe(false);
    expect(realKeyRequired({ BLOG0_REQUIRE_REAL_KEY: '0' })).toBe(false);
  });

  it('falls back to CI=true when the flag is unset or empty', () => {
    expect(realKeyRequired({ CI: 'true' })).toBe(true);
    expect(realKeyRequired({ BLOG0_REQUIRE_REAL_KEY: '', CI: 'true' })).toBe(true);
    expect(realKeyRequired({})).toBe(false);
    expect(realKeyRequired({ CI: '1' })).toBe(false);
  });

  it('treats any other flag value as unset (CI decides)', () => {
    expect(realKeyRequired({ BLOG0_REQUIRE_REAL_KEY: 'yes', CI: 'true' })).toBe(true);
    expect(realKeyRequired({ BLOG0_REQUIRE_REAL_KEY: 'true' })).toBe(false);
  });

  it('reads process.env by default', () => {
    const saved = { flag: process.env.BLOG0_REQUIRE_REAL_KEY, ci: process.env.CI };
    try {
      process.env.BLOG0_REQUIRE_REAL_KEY = '1';
      delete process.env.CI;

      expect(realKeyRequired()).toBe(true);
    } finally {
      if (saved.flag === undefined) delete process.env.BLOG0_REQUIRE_REAL_KEY;
      else process.env.BLOG0_REQUIRE_REAL_KEY = saved.flag;
      if (saved.ci === undefined) delete process.env.CI;
      else process.env.CI = saved.ci;
    }
  });
});
