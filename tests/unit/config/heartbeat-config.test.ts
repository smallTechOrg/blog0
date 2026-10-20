import { inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '@/server/config';

// Stage A config rows BLOG0_HEARTBEAT_BACKUP_URL / BLOG0_HEARTBEAT_TICK_URL (spec/architecture.md
// §10): optional absolute http(s) URLs, secret fields (the URL is the credential).

const BASE = {
  BLOG0_DATABASE_URL: 'postgres://sai@localhost:5432/blog0_dev',
  BLOG0_SESSION_SECRET: 'unit-test-session-secret-that-is-long-enough-1234',
  BLOG0_OPENROUTER_API_KEY: 'unit-test-openrouter-key-not-real',
};

function problemsOf(env: Record<string, string | undefined>): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error('expected a ConfigError');
}

describe('heartbeat URLs', () => {
  it('unset or empty → null', () => {
    expect(loadConfig(BASE).heartbeats).toEqual({ backupUrl: null, tickUrl: null });
    expect(loadConfig({ ...BASE, BLOG0_HEARTBEAT_BACKUP_URL: '  ' }).heartbeats.backupUrl).toBeNull();
  });

  it('absolute http(s) → a Secret that never prints', () => {
    const config = loadConfig({ ...BASE, BLOG0_HEARTBEAT_BACKUP_URL: 'https://hc-ping.com/uuid-backup', BLOG0_HEARTBEAT_TICK_URL: ' http://127.0.0.1:8000/ping/uuid-tick ' });
    expect(config.heartbeats.backupUrl?.reveal()).toBe('https://hc-ping.com/uuid-backup');
    expect(config.heartbeats.tickUrl?.reveal()).toBe('http://127.0.0.1:8000/ping/uuid-tick');
    expect(JSON.stringify(config)).not.toContain('uuid-backup');
    expect(inspect(config, { depth: 5 })).not.toContain('uuid-tick');
  });

  it('anything else → one aggregated ConfigError naming the variable, never the value', () => {
    const problems = problemsOf({ ...BASE, BLOG0_HEARTBEAT_BACKUP_URL: 'hc-ping.com/secret-uuid', BLOG0_HEARTBEAT_TICK_URL: 'ftp://x.example/secret-uuid' });
    expect(problems).toEqual([
      'BLOG0_HEARTBEAT_BACKUP_URL must be an absolute http(s) URL (e.g. https://hc-ping.com/<uuid>)',
      'BLOG0_HEARTBEAT_TICK_URL must be an absolute http(s) URL (e.g. https://hc-ping.com/<uuid>)',
    ]);
    expect(problems.join(' ')).not.toContain('secret-uuid');
  });
});
