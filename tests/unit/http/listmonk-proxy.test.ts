import { match } from 'next/dist/compiled/path-to-regexp';
import { describe, expect, it } from 'vitest';

import { isListmonkProxyPath, listmonkProxyRewrites, listmonkProxyTarget } from '@/lib/http/listmonk-proxy';

const C = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const S = 'ffffffff-0000-4000-8000-123456789abc';
const L = 'abcdefab-cdef-4abc-8def-abcdefabcdef';

const ALLOWED = [
  `/lm/link/${L}/${C}/${S}`,
  `/lm/campaign/${C}/${S}/px.png`,
  `/lm/subscription/${C}/${S}`,
  '/lm/public/static/style.css',
  '/lm/public/static/logo.svg',
  '/lm/public/static/favicon.png',
  '/lm/public/custom.css',
  '/lm/public/custom.js',
  // the unsubscribe page requests its assets with absolute paths (Listmonk ignores root_url for them)
  '/public/static/style.css',
  '/public/static/logo.svg',
  '/public/static/favicon.png',
  '/public/custom.css',
  '/public/custom.js',
];

const DENIED = [
  '/lm',
  '/lm/',
  '/lm/admin',
  '/lm/admin/login',
  '/lm/admin/campaigns',
  '/lm/api/health',
  '/lm/api/subscribers',
  '/lm/uploads/x.png',
  '/lm/webhooks/service/ses',
  '/lm/archive',
  '/lm/subscription/form',
  '/lm/subscription/optin/' + S,
  `/lm/subscription/export/${S}`,
  `/lm/subscription/wipe/${S}`,
  `/lm/campaign/${C}/${S}`, // "view in browser" - blog0's template does not use it
  `/lm/campaign/${C}/${S}/px.png/extra`,
  `/lm/campaign/${C}/${S}/px-png`,
  `/lm/link/${C}/${S}`,
  `/lm/link/${L}/${C}/${S}/x`,
  '/lm/link/not-a-uuid/not-a-uuid/not-a-uuid',
  `/lm/link/${L}/${C}/..`,
  `/lm/subscription/${C}/${S}/extra`,
  `/lm/subscription/${C}/..`,
  '/lm/public/static/',
  '/lm/public/static/..',
  '/lm/public/static/.env',
  '/lm/public/static/a/b.css',
  '/lm/public/static/..%2fadmin',
  '/lm/public/static/%2e%2e',
  '/lm/public/custom.css/x',
  '/lm/public/customXcss',
  '/lm/public/',
  '/lmadmin',
  '/lm2/link/' + L,
  '/link/' + `${L}/${C}/${S}`, // the unprefixed path is blog0's, never proxied
  '/public/',
  '/public/static/',
  '/public/static/..',
  '/public/static/a/b.css',
  '/public/custom.css/x',
  '/public/other.txt',
  '/public/admin',
  '/favicon.ico',
];

describe('listmonkProxyRewrites', () => {
  const rules = listmonkProxyRewrites('http://listmonk:9000/');
  const sourceMatches = (path: string) => rules.filter((r) => match(r.source)(path) !== false);

  it('every allow-listed path matches exactly one rewrite source (Next path-to-regexp)', () => {
    for (const p of ALLOWED) expect(sourceMatches(p), p).toHaveLength(1);
  });

  it('admin, api, export, wipe, optin, the bare prefix and traversal tricks match no source', () => {
    for (const p of DENIED) expect(sourceMatches(p), p).toHaveLength(0);
  });

  it('the runtime check used by src/proxy.ts agrees with the rewrite sources on every sample', () => {
    for (const p of ALLOWED) expect(isListmonkProxyPath(p), p).toBe(true);
    for (const p of DENIED) expect(isListmonkProxyPath(p), p).toBe(false);
  });

  it('strips /lm and keeps the matched parameters in the destination', () => {
    const link = rules.find((r) => r.source.startsWith('/lm/link/'));
    expect(link?.destination).toBe('http://listmonk:9000/link/:link/:camp/:sub');
    const dests = rules.map((r) => r.destination);
    expect(dests).toContain('http://listmonk:9000/campaign/:camp/:sub/px.png');
    expect(dests).toContain('http://listmonk:9000/subscription/:camp/:sub');
    expect(dests).toContain('http://listmonk:9000/public/static/:file');
    expect(dests).toContain('http://listmonk:9000/public/custom.css');
    expect(dests).toContain('http://listmonk:9000/public/custom.js');
    expect(rules).toHaveLength(9); // 6 under /lm + the 3 absolute-path assets
    expect(dests.every((d) => !d.includes('/lm') && !d.includes('('))).toBe(true);
  });

  it('proxies the three absolute asset paths without the prefix, to the same Listmonk paths', () => {
    const bare = rules.filter((r) => !r.source.startsWith('/lm/'));
    expect(bare.map((r) => r.destination).sort()).toEqual([
      'http://listmonk:9000/public/custom.css',
      'http://listmonk:9000/public/custom.js',
      'http://listmonk:9000/public/static/:file',
    ]);
  });

  it('rejects a target that is not a bare http(s) origin', () => {
    expect(() => listmonkProxyRewrites('listmonk:9000')).toThrow(/BLOG0_LM_PROXY_TARGET/);
    expect(() => listmonkProxyRewrites('http://listmonk:9000/admin')).toThrow(/BLOG0_LM_PROXY_TARGET/);
  });
});

describe('listmonkProxyTarget (build-time switch)', () => {
  it('is off without the env (local dev, tests)', () => {
    expect(listmonkProxyTarget({})).toBeNull();
    expect(listmonkProxyTarget({ BLOG0_STANDALONE: '0', BLOG0_LM_PROXY_TARGET: '  ' })).toBeNull();
  });
  it('defaults to the compose service on the image build', () => {
    expect(listmonkProxyTarget({ BLOG0_STANDALONE: '1' })).toBe('http://listmonk:9000');
  });
  it('an explicit target wins', () => {
    expect(listmonkProxyTarget({ BLOG0_LM_PROXY_TARGET: 'http://127.0.0.1:9001', BLOG0_STANDALONE: '1' })).toBe('http://127.0.0.1:9001');
  });
});
