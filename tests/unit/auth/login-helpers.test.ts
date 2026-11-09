import { describe, expect, it } from 'vitest';

import { clientIpFromRequest, normalizeEmail, safeNextPath } from '@/server/auth/login';

describe('safeNextPath', () => {
  it('keeps same-site paths with their query string', () => {
    expect(safeNextPath('/admin/articles/abc?tab=tldr')).toBe('/admin/articles/abc?tab=tldr');
    expect(safeNextPath('/admin')).toBe('/admin');
  });

  it('falls back to /admin for missing, absolute, protocol-relative or backslash paths', () => {
    expect(safeNextPath(undefined)).toBe('/admin');
    expect(safeNextPath('')).toBe('/admin');
    expect(safeNextPath('https://evil.example/admin')).toBe('/admin');
    expect(safeNextPath('//evil.example')).toBe('/admin');
    expect(safeNextPath('/\\evil.example')).toBe('/admin');
    expect(safeNextPath(['/admin/x', '/admin/y'])).toBe('/admin/x');
  });

  it('never returns to the sign-in page itself', () => {
    expect(safeNextPath('/admin/login?next=%2Fadmin')).toBe('/admin');
  });
});

describe('clientIpFromRequest', () => {
  const req = (headers: Record<string, string>) => new Request('http://localhost/', { headers });

  it('with 0 trusted proxy hops ignores x-forwarded-for and x-real-ip entirely (client-controlled)', () => {
    expect(clientIpFromRequest(req({ 'x-forwarded-for': '1.1.1.1, 10.0.0.9' }), 0)).toBe('direct');
    expect(clientIpFromRequest(req({ 'x-real-ip': '10.0.0.7' }), 0)).toBe('direct');
    expect(clientIpFromRequest(req({}), 0)).toBe('direct');
  });

  it('with N trusted hops takes the Nth entry from the right, so spoofed left entries are ignored', () => {
    expect(clientIpFromRequest(req({ 'x-forwarded-for': '1.1.1.1, 10.0.0.9' }), 1)).toBe('10.0.0.9');
    expect(clientIpFromRequest(req({ 'x-forwarded-for': 'spoofed, 203.0.113.5' }), 1)).toBe('203.0.113.5');
    expect(clientIpFromRequest(req({ 'x-forwarded-for': 'spoofed, 1.1.1.1, 10.0.0.9' }), 2)).toBe('1.1.1.1');
  });

  it('answers "unknown" when the trusted proxies did not supply enough hops (never x-real-ip)', () => {
    expect(clientIpFromRequest(req({ 'x-forwarded-for': '10.0.0.9' }), 2)).toBe('unknown');
    expect(clientIpFromRequest(req({ 'x-real-ip': '10.0.0.7' }), 1)).toBe('unknown');
    expect(clientIpFromRequest(req({ 'x-forwarded-for': ' , ' }), 1)).toBe('unknown');
  });
});

describe('normalizeEmail', () => {
  it('trims and lower-cases', () => {
    expect(normalizeEmail('  Sai@SmallTech.IN ')).toBe('sai@smalltech.in');
  });
});
