// infra/lib/urlmap-patch.mjs — the additive patch provision.sh applies to the SHARED url map
// (zero-vanguard-urlmap; spec/architecture.md §12.7). Pure: no gcloud. The invariant under test:
// nothing that is not blog0's is ever removed, reordered or changed.
import { describe, expect, it } from 'vitest';

import { NEWS_PUBLIC_PATHS, patchUrlMap, UrlMapPatchError } from '../../../infra/lib/urlmap-patch.mjs';

const P = 'https://www.googleapis.com/compute/v1/projects/p/global/backendServices';
const OPTS = { site: 'blog0.smalltech.in', news: 'news.blog0.smalltech.in', siteService: `${P}/blog0-bes`, newsService: `${P}/blog0-listmonk-bes` };

/** The shape of the live map (default service only) plus a foreign host rule to protect. */
function liveMap() {
  return {
    creationTimestamp: '2026-07-12T01:50:04.263-07:00',
    defaultService: `${P}/zero-vanguard-bes`,
    fingerprint: 'uARI73b4mcA=',
    id: '6251784790282791892',
    kind: 'compute#urlMap',
    name: 'zero-vanguard-urlmap',
    selfLink: 'https://www.googleapis.com/compute/v1/projects/p/global/urlMaps/zero-vanguard-urlmap',
    hostRules: [{ hosts: ['other.smalltech.in'], pathMatcher: 'other' }],
    pathMatchers: [{ name: 'other', defaultService: `${P}/other-bes`, pathRules: [{ paths: ['/x/*'], service: `${P}/x-bes` }] }],
  };
}

describe('patchUrlMap', () => {
  it('appends blog0 host rules + path matchers after the existing ones, keeping the fingerprint and default service', () => {
    const before = liveMap();
    const { map, changed, actions } = patchUrlMap(before, OPTS);
    expect(changed).toBe(true);
    expect(actions).toHaveLength(4);
    expect(map.fingerprint).toBe('uARI73b4mcA=');
    expect(map.defaultService).toBe(`${P}/zero-vanguard-bes`);
    expect(map.hostRules[0]).toEqual(before.hostRules[0]);
    expect(map.pathMatchers[0]).toEqual(before.pathMatchers[0]);
    expect(map.hostRules.slice(1)).toEqual([
      { hosts: ['blog0.smalltech.in'], pathMatcher: 'blog0' },
      { hosts: ['news.blog0.smalltech.in'], pathMatcher: 'blog0-news' },
    ]);
    const news = map.pathMatchers.find((m: { name: string }) => m.name === 'blog0-news');
    expect(news.defaultRouteAction).toEqual({ faultInjectionPolicy: { abort: { httpStatus: 404, percentage: 100 } } });
    expect(news.pathRules).toEqual([{ paths: [...NEWS_PUBLIC_PATHS], service: `${P}/blog0-listmonk-bes` }]);
    // output-only fields are dropped; the input object is not mutated
    expect(map.id).toBeUndefined();
    expect(before.hostRules).toHaveLength(1);
  });

  it('is idempotent: a second patch is unchanged, also when GCP echoes extra defaults on our matchers', () => {
    const once = patchUrlMap(liveMap(), OPTS).map;
    once.pathMatchers[1].description = '';
    once.pathMatchers[2].description = '';
    const twice = patchUrlMap(once, OPTS);
    expect(twice.changed).toBe(false);
    expect(twice.actions).toEqual([]);
  });

  it('works on a map with no host rules or path matchers at all (the live map today)', () => {
    const bare = { defaultService: `${P}/zero-vanguard-bes`, fingerprint: 'f', name: 'zero-vanguard-urlmap' };
    const { map } = patchUrlMap(bare, OPTS);
    expect(map.hostRules.map((r: { pathMatcher: string }) => r.pathMatcher)).toEqual(['blog0', 'blog0-news']);
  });

  it('updates its OWN matcher in place when the backend changed, never touching others', () => {
    const once = patchUrlMap(liveMap(), OPTS).map;
    const moved = patchUrlMap(once, { ...OPTS, siteService: `${P}/blog0-bes-v2` });
    expect(moved.actions).toEqual(['update path matcher blog0']);
    expect(moved.map.pathMatchers.map((m: { name: string }) => m.name)).toEqual(['other', 'blog0', 'blog0-news']);
    expect(moved.map.pathMatchers[0]).toEqual(liveMap().pathMatchers[0]);
  });

  it('refuses a host that is already routed to a matcher blog0 does not own (conflict, nothing returned)', () => {
    const taken = liveMap();
    taken.hostRules.push({ hosts: ['blog0.smalltech.in'], pathMatcher: 'other' });
    expect(() => patchUrlMap(taken, OPTS)).toThrow(UrlMapPatchError);
    expect(() => patchUrlMap(taken, OPTS)).toThrow(/already routed to path matcher 'other'/);
  });

  it('rejects missing options and identical site/news hosts', () => {
    expect(() => patchUrlMap(liveMap(), { ...OPTS, siteService: '' })).toThrow(/missing siteService/);
    expect(() => patchUrlMap(liveMap(), { ...OPTS, news: OPTS.site })).toThrow(/must differ/);
  });
});
