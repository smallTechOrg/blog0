#!/usr/bin/env node
// Patch of the SHARED url map (zero-vanguard-urlmap) for blog0 - infra/provision.sh,
// spec/architecture.md §12.7, docs/deploy-gcp.md.
//
//   node infra/lib/urlmap-patch.mjs --in <describe.json> --out <patched.json> \
//     --site <blog0 host> --site-service <bes url>
//
// Input = `gcloud compute url-maps describe <map> --global --format=json`. Output = the same map
// (JSON is valid YAML, so `gcloud compute url-maps validate|import --source` read it as is) where
// ONLY blog0's own entries differ:
//   host rule  <site> -> path matcher `blog0`  (default service: blog0-bes)     added / updated in place
//   host rule  news.blog0.smalltech.in -> path matcher `blog0-news`              REMOVED (legacy, owner
//   path matcher `blog0-news`                                                    decision: one host only)
// Single host: Listmonk's public endpoints are served by blog0 itself under /lm (Next.js rewrites), so
// the LB needs no second backend. Rules: foreign host rules / path matchers / tests / defaults are never
// removed, reordered or changed - asserted after patching (throws otherwise). The legacy removal FAILS
// CLOSED unless the entries are exactly what an earlier provision run created (the legacy host alone in
// its rule -> `blog0-news`; that matcher referenced by no other rule, backed only by blog0-listmonk-bes;
// no url-map test on the legacy host). A host already routed to a different matcher is a conflict:
// exit 1, nothing written. The fingerprint is kept (import fails rather than overwrite a concurrent
// change). Prints one line: `urlmap-patch: unchanged` | `urlmap-patch: changed (<actions>)`.
// Exit 0 ok, 1 conflict / invariant failure, 2 usage.
import { readFileSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

export const SITE_MATCHER = 'blog0';
/** blog0's legacy second host and its matcher / backend (removed by this patch; nothing else is). */
export const LEGACY_NEWS_HOST = 'news.blog0.smalltech.in';
export const LEGACY_NEWS_MATCHER = 'blog0-news';
export const LEGACY_NEWS_SERVICE = 'blog0-listmonk-bes';
const OURS = new Set([SITE_MATCHER, LEGACY_NEWS_MATCHER]);
/** Output-only fields of a describe; import ignores them, we drop them for a clean diff. */
const OUTPUT_ONLY = ['id', 'kind', 'selfLink', 'creationTimestamp'];

export class UrlMapPatchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UrlMapPatchError';
  }
}

export function desiredMatchers({ siteService }) {
  return [{ name: SITE_MATCHER, defaultService: siteService }];
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

const hostsOf = (rule) => (Array.isArray(rule.hosts) ? rule.hosts : []);
const serviceName = (url) => (typeof url === 'string' ? url.split('/').pop() : undefined);

/** Throws unless the legacy matcher is exactly what blog0 once created (see the header). */
function assertLegacyIsOurs(map, hostRules, matcher) {
  const refs = hostRules.filter((r) => r.pathMatcher === LEGACY_NEWS_MATCHER);
  for (const r of refs) {
    if (!isDeepStrictEqual(hostsOf(r), [LEGACY_NEWS_HOST])) {
      throw new UrlMapPatchError(`host rule ${JSON.stringify(hostsOf(r))} uses path matcher '${LEGACY_NEWS_MATCHER}' - not exactly [${LEGACY_NEWS_HOST}]; refusing to remove it`);
    }
  }
  const legacyHostRules = hostRules.filter((r) => hostsOf(r).includes(LEGACY_NEWS_HOST));
  for (const r of legacyHostRules) {
    if (r.pathMatcher !== LEGACY_NEWS_MATCHER) {
      throw new UrlMapPatchError(`host ${LEGACY_NEWS_HOST} is routed to path matcher '${r.pathMatcher}' (not ${LEGACY_NEWS_MATCHER}) - refusing to remove a rule blog0 does not own`);
    }
  }
  if ((map.tests ?? []).some((t) => t.host === LEGACY_NEWS_HOST)) {
    throw new UrlMapPatchError(`a url-map test targets ${LEGACY_NEWS_HOST}; refusing to remove it`);
  }
  if (matcher) {
    const services = new Set([matcher.defaultService, ...(matcher.pathRules ?? []).map((p) => p.service)]);
    if ([...services].some((u) => serviceName(u) !== LEGACY_NEWS_SERVICE)) {
      throw new UrlMapPatchError(`path matcher '${LEGACY_NEWS_MATCHER}' routes to something other than ${LEGACY_NEWS_SERVICE}; refusing to remove it`);
    }
    if (matcher.routeRules || matcher.pathRules?.some((p) => !p.service)) {
      throw new UrlMapPatchError(`path matcher '${LEGACY_NEWS_MATCHER}' has an unexpected shape; refusing to remove it`);
    }
  }
}

/**
 * Pure: returns { map, changed, actions }. Throws UrlMapPatchError on a conflict / unexpected state.
 * @param {Record<string, any>} input  the described url map
 */
export function patchUrlMap(input, { site, siteService }) {
  for (const [k, v] of Object.entries({ site, siteService })) {
    if (typeof v !== 'string' || v === '') throw new UrlMapPatchError(`missing ${k}`);
  }
  if (site === LEGACY_NEWS_HOST) throw new UrlMapPatchError(`site must not be the legacy host ${LEGACY_NEWS_HOST}`);
  const map = structuredClone(input);
  for (const k of OUTPUT_ONLY) delete map[k];
  let hostRules = Array.isArray(map.hostRules) ? map.hostRules : [];
  let pathMatchers = Array.isArray(map.pathMatchers) ? map.pathMatchers : [];
  const actions = [];

  // 1. the legacy news host rule + matcher go (host rule first: a matcher still referenced cannot be dropped).
  assertLegacyIsOurs(map, hostRules, pathMatchers.find((m) => m.name === LEGACY_NEWS_MATCHER));
  if (hostRules.some((r) => r.pathMatcher === LEGACY_NEWS_MATCHER)) {
    hostRules = hostRules.filter((r) => r.pathMatcher !== LEGACY_NEWS_MATCHER);
    actions.push(`remove host rule ${LEGACY_NEWS_HOST} -> ${LEGACY_NEWS_MATCHER}`);
  }
  if (pathMatchers.some((m) => m.name === LEGACY_NEWS_MATCHER)) {
    pathMatchers = pathMatchers.filter((m) => m.name !== LEGACY_NEWS_MATCHER);
    actions.push(`remove path matcher ${LEGACY_NEWS_MATCHER}`);
  }

  // 2. blog0's single host.
  for (const wanted of desiredMatchers({ siteService })) {
    const i = pathMatchers.findIndex((m) => m.name === wanted.name);
    if (i === -1) {
      pathMatchers.push(wanted);
      actions.push(`add path matcher ${wanted.name}`);
    } else if (!covers(pathMatchers[i], wanted)) {
      pathMatchers[i] = wanted;
      actions.push(`update path matcher ${wanted.name}`);
    }
  }
  const owner = hostRules.find((r) => hostsOf(r).includes(site));
  if (owner) {
    if (owner.pathMatcher !== SITE_MATCHER) {
      throw new UrlMapPatchError(`host ${site} is already routed to path matcher '${owner.pathMatcher}' (not ${SITE_MATCHER}) - refusing to change a rule blog0 does not own`);
    }
  } else {
    hostRules.push({ hosts: [site], pathMatcher: SITE_MATCHER });
    actions.push(`add host rule ${site} -> ${SITE_MATCHER}`);
  }

  if (hostRules.length > 0) map.hostRules = hostRules;
  else delete map.hostRules;
  if (pathMatchers.length > 0) map.pathMatchers = pathMatchers;
  else delete map.pathMatchers;
  assertOnlyBlog0Changed(input, map);
  return { map, changed: actions.length > 0, actions };
}

/** Everything that is not blog0's must be byte-for-byte where it was; blog0's own entries only as intended. */
export function assertOnlyBlog0Changed(before, after) {
  for (const key of Object.keys(before)) {
    if (OUTPUT_ONLY.includes(key) || key === 'hostRules' || key === 'pathMatchers') continue;
    if (!isDeepStrictEqual(before[key], after[key])) throw new UrlMapPatchError(`invariant: top-level field '${key}' changed`);
  }
  for (const key of Object.keys(after)) {
    if (!(key in before) && key !== 'hostRules' && key !== 'pathMatchers') throw new UrlMapPatchError(`invariant: unexpected new field '${key}'`);
  }
  const foreignMatchers = (m) => (m.pathMatchers ?? []).filter((p) => !OURS.has(p.name));
  if (!isDeepStrictEqual(foreignMatchers(before), foreignMatchers(after))) {
    throw new UrlMapPatchError("invariant: a path matcher that is not blog0's changed or moved");
  }
  const foreignRules = (m) => (m.hostRules ?? []).filter((r) => !OURS.has(r.pathMatcher));
  if (!isDeepStrictEqual(foreignRules(before), foreignRules(after))) {
    throw new UrlMapPatchError("invariant: a host rule that is not blog0's changed or moved");
  }
  // After the patch blog0 owns exactly one host rule (its site) and one matcher.
  const oursRules = (after.hostRules ?? []).filter((r) => OURS.has(r.pathMatcher));
  if (oursRules.length !== 1 || oursRules[0].pathMatcher !== SITE_MATCHER) throw new UrlMapPatchError('invariant: blog0 must own exactly the one site host rule');
  if ((after.pathMatchers ?? []).some((p) => p.name === LEGACY_NEWS_MATCHER)) throw new UrlMapPatchError('invariant: legacy path matcher still present');
  // The site rule, if it already existed, keeps its position; the order of everything else is a prefix.
  const names = (m) => (m.pathMatchers ?? []).map((p) => p.name).filter((n) => n !== LEGACY_NEWS_MATCHER);
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
    const m = /^--(in|out|site|site-service)$/.exec(a);
    if (!m || i + 1 >= argv.length) return null;
    out[m[1]] = argv[(i += 1)];
  }
  for (const k of ['in', 'out', 'site', 'site-service']) if (!out[k]) return null;
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error('usage: urlmap-patch.mjs --in <describe.json> --out <patched.json> --site <host> --site-service <url>');
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
      siteService: args['site-service'],
    });
    writeFileSync(args.out, `${JSON.stringify(map, null, 2)}\n`);
    console.log(changed ? `urlmap-patch: changed (${actions.join('; ')})` : 'urlmap-patch: unchanged');
  } catch (error) {
    console.error(`urlmap-patch: FAIL — ${error.message}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
