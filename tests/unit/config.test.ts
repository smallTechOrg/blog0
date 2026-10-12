import { inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig, loadDatabaseUrl, Secret } from '@/server/config';

const SESSION_SECRET = 'unit-test-session-secret-that-is-long-enough-1234';
const API_KEY = 'unit-test-openrouter-key-not-real';

function baseEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    BLOG0_DATABASE_URL: 'postgres://sai@localhost:5432/blog0_dev',
    BLOG0_SESSION_SECRET: SESSION_SECRET,
    BLOG0_OPENROUTER_API_KEY: API_KEY,
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

describe('loadConfig', () => {
  it('applies every documented default when only the required values are set', () => {
    const env = baseEnv();

    const config = loadConfig(env);

    expect(config.databaseUrl).toBe('postgres://sai@localhost:5432/blog0_dev');
    expect(config.port).toBe(3410);
    expect(config.publicBaseUrl).toBe('http://localhost:3410');
    expect(config.siteSlug).toBe('blog0');
    expect(config.openrouterBaseUrl).toBe('https://openrouter.ai/api/v1');
    expect(config.jevModel).toBe('google/gemini-2.5-flash');
    expect(config.jevTimeoutMs).toBe(45_000);
    expect(config.logLevel).toBe('info');
    expect(config.logFile).toBeNull();
    expect(config.adminName).toBe('Sai Krishna V');
    expect(config.storageDir).toBe('./var/storage');
    expect([config.maxAudioMb, config.maxAudioMinutes, config.maxImageMb]).toEqual([50, 30, 8]);
    expect(config.testDatabaseUrl).toBeNull();
    expect(config.e2eBaseUrl).toBeNull();
  });

  it('throws one error listing every missing required value and pointing at .env', () => {
    const env = {};

    const run = () => loadConfig(env);

    expect(run).toThrow(ConfigError);
    expect(run).toThrow(/\.env/);
    const problems = problemsOf(env);
    expect(problems).toHaveLength(3);
    expect(problems.join('\n')).toMatch(/BLOG0_DATABASE_URL/);
    expect(problems.join('\n')).toMatch(/BLOG0_SESSION_SECRET/);
    expect(problems.join('\n')).toMatch(/BLOG0_OPENROUTER_API_KEY/);
  });

  it('rejects invalid values with a precise message per variable', () => {
    const env = baseEnv({
      BLOG0_DATABASE_URL: 'mysql://localhost/blog0',
      BLOG0_PORT: '99999',
      BLOG0_SESSION_SECRET: 'too-short',
      BLOG0_LOG_LEVEL: 'verbose',
      BLOG0_PUBLIC_BASE_URL: 'not a url',
      BLOG0_SITE_SLUG: 'Not A Slug',
      BLOG0_ADMIN_PASSWORD: 'short',
      BLOG0_JEV_TIMEOUT_MS: '12abc',
    });

    const problems = problemsOf(env);

    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^BLOG0_DATABASE_URL must be a postgres/),
        expect.stringMatching(/^BLOG0_PORT must be an integer/),
        expect.stringMatching(/^BLOG0_SESSION_SECRET must be at least 32/),
        expect.stringMatching(/^BLOG0_LOG_LEVEL must be one of/),
        expect.stringMatching(/^BLOG0_PUBLIC_BASE_URL must be an absolute/),
        expect.stringMatching(/^BLOG0_SITE_SLUG must be lowercase/),
        expect.stringMatching(/^BLOG0_ADMIN_PASSWORD must be at least 12/),
        expect.stringMatching(/^BLOG0_JEV_TIMEOUT_MS must be an integer/),
      ]),
    );
    expect(problems).toHaveLength(8);
  });

  it('trims values and strips a trailing comment from non-secret fields', () => {
    const env = baseEnv({
      BLOG0_PORT: ' 4000   # local override',
      BLOG0_JEV_MODEL: 'anthropic/claude-haiku-4.5 # cheaper',
      BLOG0_PUBLIC_BASE_URL: 'https://blog.example.com/  ',
      BLOG0_LOG_FILE: '   ',
      BLOG0_SESSION_SECRET: `  ${SESSION_SECRET}#keep  `,
    });

    const config = loadConfig(env);

    expect(config.port).toBe(4000);
    expect(config.jevModel).toBe('anthropic/claude-haiku-4.5');
    expect(config.publicBaseUrl).toBe('https://blog.example.com');
    expect(config.logFile).toBeNull();
    expect(config.sessionSecret.reveal()).toBe(`${SESSION_SECRET}#keep`);
  });

  it('never prints a secret through JSON.stringify, String() or util.inspect', () => {
    const config = loadConfig(baseEnv({ BLOG0_ADMIN_PASSWORD: 'admin-password-long-enough' }));

    const outputs = [JSON.stringify(config), String(config.openrouterApiKey), `${config.sessionSecret}`, inspect(config, { depth: 5 })];

    for (const output of outputs) {
      expect(output).not.toContain(API_KEY);
      expect(output).not.toContain(SESSION_SECRET);
      expect(output).not.toContain('admin-password-long-enough');
    }
    expect(JSON.stringify(config)).toContain('[redacted]');
    expect(config.openrouterApiKey).toBeInstanceOf(Secret);
    expect(config.openrouterApiKey.reveal()).toBe(API_KEY);
  });

  it('rejects the .env.example placeholder secrets with a message pointing at .env, never echoing the value', () => {
    const env = baseEnv({
      BLOG0_SESSION_SECRET: 'replace-with-output-of-openssl-rand-base64-48',
      BLOG0_OPENROUTER_API_KEY: 'replace-with-your-openrouter-key',
      BLOG0_ADMIN_PASSWORD: 'replace-with-a-12-plus-char-password',
      BLOG0_NEW_ADMIN_PASSWORD: '  replace-with-anything-long-enough  ',
    });

    const problems = problemsOf(env);
    const message = (() => {
      try {
        loadConfig(env);
      } catch (error) {
        return (error as Error).message;
      }
      return '';
    })();

    expect(problems).toEqual([
      expect.stringMatching(/^BLOG0_SESSION_SECRET still holds the \.env\.example placeholder .*\.env/),
      expect.stringMatching(/^BLOG0_OPENROUTER_API_KEY still holds the \.env\.example placeholder .*\.env/),
      expect.stringMatching(/^BLOG0_ADMIN_PASSWORD still holds the \.env\.example placeholder .*\.env/),
      expect.stringMatching(/^BLOG0_NEW_ADMIN_PASSWORD still holds the \.env\.example placeholder .*\.env/),
    ]);
    expect(message).toMatch(/\.env/);
    expect(message).not.toMatch(/replace-with-/);
  });

  it('accepts real-looking secrets and the keyless test value pending-placeholder', () => {
    const env = baseEnv({
      BLOG0_OPENROUTER_API_KEY: 'pending-placeholder',
      BLOG0_SESSION_SECRET: 'a-secret-that-merely-contains-replace-with-inside-it',
    });

    const config = loadConfig(env);

    expect(config.openrouterApiKey.reveal()).toBe('pending-placeholder');
    expect(config.sessionSecret.reveal()).toBe('a-secret-that-merely-contains-replace-with-inside-it');
  });

  it('lower-cases the admin email and accepts an absent admin block', () => {
    const withAdmin = loadConfig(baseEnv({ BLOG0_ADMIN_EMAIL: 'Sai@SmallTech.in' }));
    const withoutAdmin = loadConfig(baseEnv());

    expect(withAdmin.adminEmail).toBe('sai@smalltech.in');
    expect(withoutAdmin.adminEmail).toBeNull();
    expect(withoutAdmin.adminPassword).toBeNull();
  });
});

describe('loadDatabaseUrl', () => {
  it('validates only the database URL so db scripts do not need the OpenRouter key', () => {
    const env = { BLOG0_DATABASE_URL: 'postgres://sai@localhost:5432/blog0_dev' };

    expect(loadDatabaseUrl(env)).toBe('postgres://sai@localhost:5432/blog0_dev');
    expect(() => loadDatabaseUrl({})).toThrow(/BLOG0_DATABASE_URL is required/);
    expect(() => loadDatabaseUrl({ BLOG0_DATABASE_URL: 'postgres://localhost:5432/' })).toThrow(/database name/);
  });
});
