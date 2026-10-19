#!/usr/bin/env node
// Additive patch of the SHARED url map (zero-vanguard-urlmap) for blog0 — infra/provision.sh,
// spec/architecture.md §12.7, docs/deploy-gcp.md.
//
//   node infra/lib/urlmap-patch.mjs --in <describe.json> --out <patched.json> \
//     --site <blog0 host> --news <news host> --site-service <bes url> --news-service <bes url>
//
// Input = `gcloud compute url-maps describe <map> --global --format=json`. Output = the same map with
// ONLY these additions (JSON is valid YAML, so `gcloud compute url-maps validate|import --source`
// read it as is):
//   host rule  <site> → path matcher `blog0`       (default: blog0-bes)
//   host rule  <news> → path matcher `blog0-news`  (Listmonk's subscriber paths → blog0-listmonk-bes;
//                                                   everything else → 404 via fault injection, never a backend)
// Rules: existing host rules / path matchers / tests / defaults are never removed, reordered or
// changed — asserted after patching (throws otherwise). Our own matchers (`blog0`, `blog0-news`) are
// updated in place when they differ. A host already routed to a different matcher is a conflict:
// exit 1, nothing written. The fingerprint is kept (import fails rather than overwrite a concurrent
// change). Prints one line: `urlmap-patch: unchanged` | `urlmap-patch: changed (<actions>)`.
// Exit 0 ok, 1 conflict / invariant failure, 2 usage.
import { readFileSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

/** Listmonk's public subscriber surface (= deploy/local/Caddyfile, the local stand-in). */
export const NEWS_PUBLIC_PATHS = Object.freeze([
  '/link/*',
  '/campaign/*',
  '/subscription/*',
  '/public/static/*',
  '/public/custom.css',
  '/public/custom.js',
]);

export const SITE_MATCHER = 'blog0';
export const NEWS_MATCHER = 'blog0-news';
const OURS = new Set([SITE_MATCHER, NEWS_MATCHER]);
/** Output-only fields of a describe; import ignores them, we drop them for a clean diff. */
const OUTPUT_ONLY = ['id', 'kind', 'selfLink', 'creationTimestamp'];

export class UrlMapPatchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UrlMapPatchError';
  }
}

export function desiredMatchers({ siteService, newsService }) {
  return [
    { name: SITE_MATCHER, defaultService: siteService },
    {
      name: NEWS_MATCHER,
      defaultService: newsService,
      // Never reaches Listmonk: the load balancer answers 404 itself (no /admin, /api, / …).
      defaultRouteAction: { faultInjectionPolicy: { abort: { httpStatus: 404, percentage: 100 } } },
      pathRules: [{ paths: [...NEWS_PUBLIC_PATHS], service: newsService }],
    },
  ];
}

/**
 * True when every field we set is present with the same value in `actual` (GCP may echo extra
 * defaults, e.g. `description`; those never cause an update). Arrays must match element-wise.
 */
export function covers(actual, wanted) {
  if (Array.isArray(wanted)) {
    return Array.isArray(actual) && actual.length === wanted.length && wanted.every((w, i) => covers(actual[i], w));
  }
  if (wanted !== null && typeof wanted === 'object') {
    return actual !== null && typeof actual === 'object' && Object.keys(wanted).every((k) => covers(actual[k], wanted[k]));
  }
  return actual === wanted;
}

const sameMatcher = (actual, wanted) => covers(actual, wanted);

const hostsOf = (rule) => (Array.isArray(rule.hosts) ? rule.hosts : []);

/**
 * Pure: returns { map, changed, actions }. Throws UrlMapPatchError on a conflict.
 * @param {Record<string, any>} input  the described url map
 */
export function patchUrlMap(input, { site, news, siteService, newsService }) {
  for (const [k, v] of Object.entries({ site, news, siteService, newsService })) {
    if (typeof v !== 'string' || v === '') throw new UrlMapPatchError(`missing ${k}`);
  }
  if (site === news) throw new UrlMapPatchError('site and news hosts must differ');
  const map = structuredClone(input);
  for (const k of OUTPUT_ONLY) delete map[k];
  const hostRules = Array.isArray(map.hostRules) ? map.hostRules : [];
  const pathMatchers = Array.isArray(map.pathMatchers) ? map.pathMatchers : [];
  const actions = [];

  for (const wanted of desiredMatchers({ siteService, newsService })) {
    const i = pathMatchers.findIndex((m) => m.name === wanted.name);
    if (i === -1) {
      pathMatchers.push(wanted);
      actions.push(`add path matcher ${wanted.name}`);
    } else if (!sameMatcher(pathMatchers[i], wanted)) {
      pathMatchers[i] = wanted;
      actions.push(`update path matcher ${wanted.name}`);
    }
  }

  for (const [host, matcher] of [
    [site, SITE_MATCHER],
    [news, NEWS_MATCHER],
  ]) {
    const owner = hostRules.find((r) => hostsOf(r).includes(host));
    if (owner) {
      if (owner.pathMatcher !== matcher) {
        throw new UrlMapPatchError(`host ${host} is already routed to path matcher '${owner.pathMatcher}' (not ${matcher}) — refusing to change a rule blog0 does not own`);
      }
      continue;
    }
    hostRules.push({ hosts: [host], pathMatcher: matcher });
    actions.push(`add host rule ${host} → ${matcher}`);
  }

  if (hostRules.length > 0) map.hostRules = hostRules;
  if (pathMatchers.length > 0) map.pathMatchers = pathMatchers;
  assertOnlyAdditive(input, map);
  return { map, changed: actions.length > 0, actions };
}

/** Everything that is not blog0's must be byte-for-byte where it was. */
export function assertOnlyAdditive(before, after) {
  for (const key of Object.keys(before)) {
    if (OUTPUT_ONLY.includes(key) || key === 'hostRules' || key === 'pathMatchers') continue;
    if (!isDeepStrictEqual(before[key], after[key])) throw new UrlMapPatchError(`invariant: top-level field '${key}' changed`);
  }
  for (const key of Object.keys(after)) {
    if (!(key in before) && key !== 'hostRules' && key !== 'pathMatchers') throw new UrlMapPatchError(`invariant: unexpected new field '${key}'`);
  }
  const foreignMatchers = (m) => (m.pathMatchers ?? []).filter((p) => !OURS.has(p.name));
  if (!isDeepStrictEqual(foreignMatchers(before), foreignMatchers(after))) {
    throw new UrlMapPatchError('invariant: a path matcher that is not blog0\'s changed or moved');
  }
  const foreignRules = (m) => (m.hostRules ?? []).filter((r) => !OURS.has(r.pathMatcher));
  if (!isDeepStrictEqual(foreignRules(before), foreignRules(after))) {
    throw new UrlMapPatchError('invariant: a host rule that is not blog0\'s changed or moved');
  }
  const ours = (m) => (m.hostRules ?? []).filter((r) => OURS.has(r.pathMatcher));
  const beforeOurs = ours(before);
  const afterOurs = ours(after);
  if (!isDeepStrictEqual(afterOurs.slice(0, beforeOurs.length), beforeOurs)) {
    throw new UrlMapPatchError('invariant: an existing blog0 host rule changed');
  }
  // Order of everything before must be a prefix (new entries are appended only).
  const names = (m) => (m.pathMatchers ?? []).map((p) => p.name);
  const before0 = names(before);
  if (!isDeepStrictEqual(names(after).slice(0, before0.length), before0)) {
    throw new UrlMapPatchError('invariant: path matcher order changed');
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') continue;
    const m = /^--(in|out|site|news|site-service|news-service)$/.exec(a);
    if (!m || i + 1 >= argv.length) return null;
    out[m[1]] = argv[(i += 1)];
  }
  for (const k of ['in', 'out', 'site', 'news', 'site-service', 'news-service']) if (!out[k]) return null;
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error('usage: urlmap-patch.mjs --in <describe.json> --out <patched.json> --site <host> --news <host> --site-service <url> --news-service <url>');
    process.exit(2);
  }
  let input;
  try {
    input = JSON.parse(readFileSync(args.in, 'utf8'));
  } catch (error) {
    console.error(`urlmap-patch: FAIL — cannot read ${args.in}: ${error.message}`);
    process.exit(2);
  }
  try {
    const { map, changed, actions } = patchUrlMap(input, {
      site: args.site,
      news: args.news,
      siteService: args['site-service'],
      newsService: args['news-service'],
    });
    writeFileSync(args.out, `${JSON.stringify(map, null, 2)}\n`);
    console.log(changed ? `urlmap-patch: changed (${actions.join('; ')})` : 'urlmap-patch: unchanged');
  } catch (error) {
    console.error(`urlmap-patch: FAIL — ${error.message}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
