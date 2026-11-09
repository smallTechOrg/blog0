import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '@/server/config';

const BASE = {
  BLOG0_DATABASE_URL: 'postgres://sai@localhost:5432/blog0_dev',
  BLOG0_SESSION_SECRET: 'x'.repeat(48),
  BLOG0_OPENROUTER_API_KEY: 'sk-or-test',
};

describe('BLOG0_TRUSTED_PROXY_HOPS', () => {
  it('defaults to 0 (no proxy: forwarding headers are not trusted)', () => {
    expect(loadConfig(BASE).trustedProxyHops).toBe(0);
    expect(loadConfig({ ...BASE, BLOG0_TRUSTED_PROXY_HOPS: '' }).trustedProxyHops).toBe(0);
  });

  it('accepts a small non-negative integer', () => {
    expect(loadConfig({ ...BASE, BLOG0_TRUSTED_PROXY_HOPS: '2' }).trustedProxyHops).toBe(2);
  });

  it('rejects negative, fractional or absurd values', () => {
    for (const bad of ['-1', '1.5', 'one', '11']) {
      expect(() => loadConfig({ ...BASE, BLOG0_TRUSTED_PROXY_HOPS: bad })).toThrow(ConfigError);
    }
    expect(() => loadConfig({ ...BASE, BLOG0_TRUSTED_PROXY_HOPS: '-1' })).toThrow(
      /BLOG0_TRUSTED_PROXY_HOPS must be an integer between 0 and 10/,
    );
  });
});
