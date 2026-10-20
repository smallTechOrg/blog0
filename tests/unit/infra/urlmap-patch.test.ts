// infra/lib/urlmap-patch.mjs — the patch provision.sh applies to the SHARED url map
// (zero-vanguard-urlmap; spec/architecture.md §12.7). Pure: no gcloud. The invariants under test:
// blog0 ends with exactly ONE host rule (blog0.smalltech.in -> `blog0`); its legacy news host rule +
// `blog0-news` matcher are removed; nothing that is not blog0's is ever removed, reordered or changed.
import { describe, expect, it } from 'vitest';

import { LEGACY_NEWS_HOST, patchUrlMap, UrlMapPatchError } from '../../../infra/lib/urlmap-patch.mjs';

const P = 'https://www.googleapis.com/compute/v1/projects/p/global/backendServices';
const OPTS = { site: 'blog0.smalltech.in', siteService: `${P}/blog0-bes` };
type Matcher = { name: string; [k: string]: unknown };

const legacyMatcher = () => ({
  name: 'blog0-news',
  defaultService: `${P}/blog0-listmonk-bes`,
  defaultRouteAction: { faultInjectionPolicy: { abort: { httpStatus: 404, percentage: 100 } } },
  pathRules: [{ paths: ['/link/*', '/campaign/*', '/subscription/*', '/public/static/*', '/public/custom.css', '/public/custom.js'], service: `${P}/blog0-listmonk-bes` }],
});

/** The live map after the first (two-host) provision run, plus foreign rules on both sides to protect. */
function liveMap() {
  return {
    creationTimestamp: '2026-07-12T01:50:04.263-07:00',
    defaultService: `${P}/zero-vanguard-bes`,
    fingerprint: 'uARI73b4mcA=',
    id: '6251784790282791892',
    kind: 'compute#urlMap',
    name: 'zero-vanguard-urlmap',
    selfLink: 'https://www.googleapis.com/compute/v1/projects/p/global/urlMaps/zero-vanguard-urlmap',
    hostRules: [
      { hosts: ['other.smalltech.in'], pathMatcher: 'other' },
      { hosts: ['blog0.smalltech.in'], pathMatcher: 'blog0' },
      { hosts: [LEGACY_NEWS_HOST], pathMatcher: 'blog0-news' },
      { hosts: ['later.smalltech.in'], pathMatcher: 'later' },
    ],
    pathMatchers: [
      { name: 'other', defaultService: `${P}/other-bes`, pathRules: [{ paths: ['/x/*'], service: `${P}/x-bes` }] },
      { name: 'blog0', defaultService: `${P}/blog0-bes` },
      legacyMatcher(),
      { name: 'later', defaultService: `${P}/later-bes` },
    ],
  };
}

const names = (m: { pathMatchers?: Matcher[] }) => (m.pathMatchers ?? []).map((p) => p.name);

describe('patchUrlMap', () => {
  it('removes exactly the legacy news host rule + blog0-news matcher and nothing else', () => {
    const before = liveMap();
    const { map, changed, actions } = patchUrlMap(before, OPTS);
    expect(changed).toBe(true);
    expect(actions).toEqual([`remove host rule ${LEGACY_NEWS_HOST} -> blog0-news`, 'remove path matcher blog0-news']);
    expect(map.hostRules).toEqual([before.hostRules[0], before.hostRules[1], before.hostRules[3]]);
    expect(names(map)).toEqual(['other', 'blog0', 'later']);
    expect(map.pathMatchers[0]).toEqual(before.pathMatchers[0]);
    expect(map.pathMatchers[2]).toEqual(before.pathMatchers[3]);
    expect(map.fingerprint).toBe('uARI73b4mcA=');
    expect(map.defaultService).toBe(`${P}/zero-vanguard-bes`);
    // output-only fields are dropped; the input object is not mutated
    expect(map.id).toBeUndefined();
    expect(before.hostRules).toHaveLength(4);
  });

  it('on a map without blog0 yet, appends the single site rule + matcher after the foreign ones', () => {
    const fresh = { ...liveMap(), hostRules: [liveMap().hostRules[0]], pathMatchers: [liveMap().pathMatchers[0]] };
    const { map, actions } = patchUrlMap(fresh, OPTS);
    expect(actions).toEqual(['add path matcher blog0', 'add host rule blog0.smalltech.in -> blog0']);
    expect(map.hostRules).toEqual([fresh.hostRules[0], { hosts: ['blog0.smalltech.in'], pathMatcher: 'blog0' }]);
    expect(map.pathMatchers).toEqual([fresh.pathMatchers[0], { name: 'blog0', defaultService: `${P}/blog0-bes` }]);
  });

  it('is idempotent: a second patch is unchanged, also when GCP echoes extra defaults on our matcher', () => {
    const once = patchUrlMap(liveMap(), OPTS).map;
    once.pathMatchers[1].description = '';
    const twice = patchUrlMap(once, OPTS);
    expect(twice.changed).toBe(false);
    expect(twice.actions).toEqual([]);
  });

  it('works on a map with no host rules or path matchers at all', () => {
    const bare = { defaultService: `${P}/zero-vanguard-bes`, fingerprint: 'f', name: 'zero-vanguard-urlmap' };
    const { map } = patchUrlMap(bare, OPTS);
    expect(map.hostRules).toEqual([{ hosts: ['blog0.smalltech.in'], pathMatcher: 'blog0' }]);
    expect(names(map)).toEqual(['blog0']);
  });

  it('finishes a half-removed legacy state (matcher left behind, or host rule only)', () => {
    const noRule = liveMap();
    noRule.hostRules = noRule.hostRules.filter((r) => r.pathMatcher !== 'blog0-news');
    expect(patchUrlMap(noRule, OPTS).actions).toEqual(['remove path matcher blog0-news']);
  });

  it('updates its OWN matcher in place when the backend changed, never touching others', () => {
    const moved = patchUrlMap(patchUrlMap(liveMap(), OPTS).map, { ...OPTS, siteService: `${P}/blog0-bes-v2` });
    expect(moved.actions).toEqual(['update path matcher blog0']);
    expect(names(moved.map)).toEqual(['other', 'blog0', 'later']);
    expect(moved.map.pathMatchers[0]).toEqual(liveMap().pathMatchers[0]);
  });

  it('refuses a site host already routed to a matcher blog0 does not own (conflict)', () => {
    const taken = liveMap();
    taken.hostRules[1] = { hosts: ['blog0.smalltech.in'], pathMatcher: 'other' };
    expect(() => patchUrlMap(taken, OPTS)).toThrow(UrlMapPatchError);
    expect(() => patchUrlMap(taken, OPTS)).toThrow(/already routed to path matcher 'other'/);
  });

  describe('fails closed when the legacy entries are not exactly what blog0 created', () => {
    it('the news host shares a rule with another host', () => {
      const m = liveMap();
      m.hostRules[2] = { hosts: [LEGACY_NEWS_HOST, 'x.smalltech.in'], pathMatcher: 'blog0-news' };
      expect(() => patchUrlMap(m, OPTS)).toThrow(/not exactly/);
    });
    it('the blog0-news matcher is referenced by a foreign host rule', () => {
      const m = liveMap();
      m.hostRules.push({ hosts: ['foreign.smalltech.in'], pathMatcher: 'blog0-news' });
      expect(() => patchUrlMap(m, OPTS)).toThrow(/not exactly/);
    });
    it('the news host is routed to a foreign matcher', () => {
      const m = liveMap();
      m.hostRules[2] = { hosts: [LEGACY_NEWS_HOST], pathMatcher: 'other' };
      expect(() => patchUrlMap(m, OPTS)).toThrow(/refusing to remove a rule blog0 does not own/);
    });
    it('the matcher routes to a backend that is not blog0-listmonk-bes', () => {
      const m = liveMap();
      (m.pathMatchers[2] as { defaultService: string }).defaultService = `${P}/someone-elses-bes`;
      expect(() => patchUrlMap(m, OPTS)).toThrow(/something other than blog0-listmonk-bes/);
    });
    it('a url-map test targets the news host', () => {
      const m = { ...liveMap(), tests: [{ host: LEGACY_NEWS_HOST, path: '/link/x', service: `${P}/blog0-listmonk-bes` }] };
      expect(() => patchUrlMap(m, OPTS)).toThrow(/url-map test/);
    });
  });

  it('rejects missing options and the legacy host as site', () => {
    expect(() => patchUrlMap(liveMap(), { ...OPTS, siteService: '' })).toThrow(/missing siteService/);
    expect(() => patchUrlMap(liveMap(), { ...OPTS, site: LEGACY_NEWS_HOST })).toThrow(/legacy host/);
  });
});
