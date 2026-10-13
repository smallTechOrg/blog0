import { describe, expect, it } from 'vitest';

import { buildContentSecurityPolicy, isHttpsOrigin, runtimeSecurityHeaders } from '@/lib/http/csp';

// spec/architecture.md §6 — the exact policy string is the contract.
const EXACT =
  "default-src 'self'; script-src 'self' 'nonce-abc' 'strict-dynamic'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self'; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; frame-src 'none'; worker-src 'self' blob:; manifest-src 'self'";

describe('buildContentSecurityPolicy', () => {
  it('equals the spec string over http', () => {
    expect(buildContentSecurityPolicy({ nonce: 'abc', https: false })).toBe(EXACT);
  });

  it('appends upgrade-insecure-requests over https', () => {
    const csp = buildContentSecurityPolicy({ nonce: 'abc', https: true });
    expect(csp).toBe(`${EXACT}; upgrade-insecure-requests`);
    expect(csp.endsWith('; upgrade-insecure-requests')).toBe(true);
  });

  it('embeds whatever nonce it is given (base64 included)', () => {
    expect(buildContentSecurityPolicy({ nonce: 'q1+/Zz==', https: false })).toContain("'nonce-q1+/Zz=='");
  });
});

describe('runtimeSecurityHeaders', () => {
  it('adds HSTS only over https', () => {
    expect(runtimeSecurityHeaders({ nonce: 'abc', https: true })['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    const http = runtimeSecurityHeaders({ nonce: 'abc', https: false });
    expect(http['strict-transport-security']).toBeUndefined();
    expect(Object.keys(http)).toEqual(['content-security-policy']);
    expect(http['content-security-policy']).toBe(EXACT);
  });
});

describe('isHttpsOrigin', () => {
  it('is true only for https origins', () => {
    expect(isHttpsOrigin('https://blog0.example')).toBe(true);
    expect(isHttpsOrigin('HTTPS://blog0.example')).toBe(true);
    expect(isHttpsOrigin('http://localhost:3410')).toBe(false);
    expect(isHttpsOrigin('')).toBe(false);
  });
});
