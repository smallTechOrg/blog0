import { inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig, Secret } from '@/server/config';

// BLOG0_UNSUBSCRIBE_SECRET (fix pass; spec/architecture.md §10): optional, ≥ 24 chars, placeholder
// rejected, redacted; null ⇒ the session secret signs.

const SESSION_SECRET = 'unit-test-session-secret-that-is-long-enough-1234';

function baseEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    BLOG0_DATABASE_URL: 'postgres://sai@localhost:5432/blog0_dev',
    BLOG0_SESSION_SECRET: SESSION_SECRET,
    BLOG0_OPENROUTER_API_KEY: 'unit-test-openrouter-key-not-real',
    ...overrides,
  };
}

function problemsOf(env: Record<string, string | undefined>): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error('expected loadConfig to throw');
}

describe('BLOG0_UNSUBSCRIBE_SECRET', () => {
  it('defaults to null (the session secret signs)', () => {
    expect(loadConfig(baseEnv()).newsletter.unsubscribeSecret).toBeNull();
    expect(loadConfig(baseEnv({ BLOG0_UNSUBSCRIBE_SECRET: '' })).newsletter.unsubscribeSecret).toBeNull();
  });

  it('wraps a value of 24+ characters in a Secret', () => {
    const config = loadConfig(baseEnv({ BLOG0_UNSUBSCRIBE_SECRET: 'unsubscribe-secret-24-chars!!' }));
    expect(config.newsletter.unsubscribeSecret).toBeInstanceOf(Secret);
    expect(config.newsletter.unsubscribeSecret?.reveal()).toBe('unsubscribe-secret-24-chars!!');
  });

  it('rejects a value under 24 characters without echoing it', () => {
    const problems = problemsOf(baseEnv({ BLOG0_UNSUBSCRIBE_SECRET: 'too-short-secret' }));
    expect(problems).toEqual([expect.stringMatching(/^BLOG0_UNSUBSCRIBE_SECRET must be at least 24 characters/)]);
    expect(problems.join('\n')).not.toContain('too-short-secret');
  });

  it('rejects the .env.example placeholder, aggregated with other problems, without echoing it', () => {
    const problems = problemsOf(baseEnv({ BLOG0_UNSUBSCRIBE_SECRET: 'replace-with-output-of-openssl-rand-base64-32', BLOG0_SESSION_SECRET: undefined }));
    expect(problems).toHaveLength(2);
    expect(problems).toContainEqual(expect.stringMatching(/^BLOG0_UNSUBSCRIBE_SECRET still holds the \.env\.example placeholder/));
    expect(problems).toContainEqual(expect.stringMatching(/^BLOG0_SESSION_SECRET is required/));
    expect(problems.join('\n')).not.toMatch(/replace-with-output/);
  });

  it('never prints through JSON.stringify or util.inspect', () => {
    const config = loadConfig(baseEnv({ BLOG0_UNSUBSCRIBE_SECRET: 'unsubscribe-secret-24-chars!!' }));
    for (const output of [JSON.stringify(config), inspect(config, { depth: 6 })]) {
      expect(output).not.toContain('unsubscribe-secret-24-chars!!');
    }
  });
});
