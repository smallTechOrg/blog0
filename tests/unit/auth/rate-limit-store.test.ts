import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '@/server/config';
import { MemoryRateLimitStore } from '@/server/rate-window';
import { createRateLimitStore, DbRateLimitStore, sha256Hex, windowStartFor } from '@/server/rate-window-store';

// BLOG0_RATE_LIMIT_STORE parsing + store selection (spec/architecture.md §6, §10) and the pure
// helpers of the database store. The DB store itself runs against real Postgres in
// tests/integration/rate-limit-db.test.ts.

const BASE = {
  BLOG0_DATABASE_URL: 'postgres://sai@localhost:5432/blog0_dev',
  BLOG0_SESSION_SECRET: 'unit-test-session-secret-that-is-long-enough-1234',
  BLOG0_OPENROUTER_API_KEY: 'unit-test-openrouter-key-not-real',
};

describe('BLOG0_RATE_LIMIT_STORE', () => {
  it('defaults to auto and accepts auto|db|memory (trailing comment tolerated)', () => {
    expect(loadConfig(BASE).rateLimitStore).toBe('auto');
    expect(loadConfig({ ...BASE, BLOG0_RATE_LIMIT_STORE: 'db' }).rateLimitStore).toBe('db');
    expect(loadConfig({ ...BASE, BLOG0_RATE_LIMIT_STORE: ' memory  # tests ' }).rateLimitStore).toBe('memory');
    expect(loadConfig({ ...BASE, BLOG0_RATE_LIMIT_STORE: '' }).rateLimitStore).toBe('auto');
  });

  it('rejects any other value with one listed problem', () => {
    try {
      loadConfig({ ...BASE, BLOG0_RATE_LIMIT_STORE: 'redis' });
      throw new Error('expected a ConfigError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).problems).toEqual(['BLOG0_RATE_LIMIT_STORE must be one of auto|db|memory']);
    }
  });
});

describe('createRateLimitStore', () => {
  it('auto → database store on postgres://, memory on pglite://; db/memory force one', () => {
    expect(createRateLimitStore({ rateLimitStore: 'auto', dbEngine: 'postgres' })).toBeInstanceOf(DbRateLimitStore);
    expect(createRateLimitStore({ rateLimitStore: 'auto', dbEngine: 'pglite' })).toBeInstanceOf(MemoryRateLimitStore);
    expect(createRateLimitStore({ rateLimitStore: 'db', dbEngine: 'pglite' }).kind).toBe('db');
    expect(createRateLimitStore({ rateLimitStore: 'memory', dbEngine: 'postgres' }).kind).toBe('memory');
  });
});

describe('database-store helpers', () => {
  it('aligns windows to fixed epoch boundaries', () => {
    const hour = 3_600_000;
    const t = Date.UTC(2026, 9, 12, 9, 42, 17);
    expect(windowStartFor(t, hour)).toBe(Date.UTC(2026, 9, 12, 9, 0, 0));
    expect(windowStartFor(Date.UTC(2026, 9, 12, 9, 0, 0), hour)).toBe(Date.UTC(2026, 9, 12, 9, 0, 0));
    expect(windowStartFor(t, 15 * 60_000)).toBe(Date.UTC(2026, 9, 12, 9, 30, 0));
  });

  it('hashes keys with SHA-256 hex', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('sai@smalltech.in')).toMatch(/^[0-9a-f]{64}$/);
  });
});
