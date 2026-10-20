import { describe, expect, it } from 'vitest';

import { isPublicHost, isPublicUrl } from '@/server/newsletter/sender/public-host';

// Stage A trackingPublic (spec/architecture.md §13.3; newsletter-issues.md): opens and clicks are
// countable only when Listmonk's root URL is reachable from a reader's mail client.

describe('isPublicHost', () => {
  it('false for loopback, single-label, .local/.internal and private ranges', () => {
    for (const host of [
      'localhost',
      'LOCALHOST',
      'app.localhost',
      'listmonk',
      'mail.local',
      'lists.internal',
      '127.0.0.1',
      '127.8.9.10',
      '10.1.2.3',
      '172.16.0.1',
      '172.20.0.5',
      '172.31.255.255',
      '192.168.1.9',
      '169.254.1.1',
      '0.0.0.0',
      '::1',
      '[::1]',
      'fd00::1',
      'fc00::5',
      'fe80::1',
      '',
    ]) {
      expect(isPublicHost(host), host).toBe(false);
    }
  });

  it('true for public names and addresses', () => {
    for (const host of ['lists.example.com', '8.8.8.8', '172.32.0.1', '172.15.0.1', '2606:4700::1111', 'news.smalltech.in.']) {
      expect(isPublicHost(host), host).toBe(true);
    }
  });

  it('isPublicUrl: the host of an absolute http(s) URL; anything else → false', () => {
    expect(isPublicUrl('https://lists.example.com/')).toBe(true);
    expect(isPublicUrl('http://localhost:9001')).toBe(false);
    expect(isPublicUrl('http://[::1]:9000')).toBe(false);
    expect(isPublicUrl('not a url')).toBe(false);
    expect(isPublicUrl('ftp://lists.example.com')).toBe(false);
  });
});
