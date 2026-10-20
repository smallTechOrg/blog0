import { describe, expect, it } from 'vitest';

import { adminCredentialsFromEnv, SeedError, validateNewAdmin } from '@/server/seed/admin';

const EMAIL = 'sai@smalltech.in';

describe('adminCredentialsFromEnv password validation', () => {
  it('refuses the .env.example placeholder without echoing it', () => {
    const run = () =>
      adminCredentialsFromEnv({ BLOG0_ADMIN_EMAIL: EMAIL, BLOG0_ADMIN_PASSWORD: 'replace-with-a-12-plus-char-password' });

    expect(run).toThrow(SeedError);
    expect(run).toThrow(/BLOG0_ADMIN_PASSWORD still holds the \.env\.example placeholder/);
    expect(run).not.toThrow(/a-12-plus-char/);
  });

  it('refuses the placeholder for pnpm admin:create too', () => {
    expect(() => validateNewAdmin({ email: EMAIL, displayName: 'B', password: 'replace-with-something-long' })).toThrow(SeedError);
  });

  it('keeps the raw password (surrounding spaces included) — trim is only for the emptiness check', () => {
    const creds = adminCredentialsFromEnv({ BLOG0_ADMIN_EMAIL: EMAIL, BLOG0_ADMIN_PASSWORD: '  padded-password-12 ' });

    expect(creds.password).toBe('  padded-password-12 ');
  });

  it('refuses a whitespace-only password as missing', () => {
    expect(() => adminCredentialsFromEnv({ BLOG0_ADMIN_EMAIL: EMAIL, BLOG0_ADMIN_PASSWORD: '              ' })).toThrow(
      /BLOG0_ADMIN_PASSWORD is missing/,
    );
  });
});
