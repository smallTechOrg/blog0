// Listmonk's PUBLIC endpoints under blog0's own host (spec/architecture.md §12.7 + §13): a single
// host `blog0.smalltech.in`, Listmonk root URL = https://<host>/lm, so every link Listmonk puts in a
// mail (click redirect, open pixel, unsubscribe page) is `/lm/...`. next.config.ts turns the rules
// below into `beforeFiles` rewrites that proxy to the internal Listmonk (the `/lm` prefix is stripped).
//
// ALLOW-LIST ONLY. Anything else under /lm (`/lm`, `/lm/admin*`, `/lm/api*`, `/lm/uploads*`,
// `/lm/subscription/{export,wipe,optin,form}…`, `/lm/campaign/<c>/<s>` "view in browser", …) matches no
// rule and falls through to blog0's normal 404. Listmonk v5.1.0 routes (verified against the test stack,
// scripts/lm-prefix-check.sh):
//   GET  /link/:linkUUID/:campUUID/:subUUID      307 to the tracked target, counts the click
//   GET  /campaign/:campUUID/:subUUID/px.png     1x1 png, counts the view
//   GET|POST /subscription/:campUUID/:subUUID    unsubscribe page + its form (List-Unsubscribe target)
//   GET  /public/static/<file>, /public/custom.css, /public/custom.js   the page's assets
// The unsubscribe page hardcodes its assets as ABSOLUTE paths (`/public/static/style.css`, `/public/custom.css`,
// `/public/custom.js`, `/public/static/logo.svg` - Listmonk ignores root_url for them; verified), so behind the
// prefix they would 404. The same three asset patterns are therefore also proxied UNPREFIXED. blog0 itself
// has no `/public/...` URL (its public/ files are served at the site root), so nothing collides.
// Parameters are UUID-shaped (or a safe file name), so no `..`, `/`, `%2f` or admin path can match.

/** The path prefix Listmonk is published under on blog0's host. */
export const LISTMONK_PROXY_PREFIX = '/lm';
/** Default internal target (the compose service `listmonk` on the VM's docker network). */
export const LISTMONK_PROXY_DEFAULT_TARGET = 'http://listmonk:9000';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** A plain file name: no slash, no leading dot (so never `.` / `..`), no percent escapes. */
const FILE = '[A-Za-z0-9_][A-Za-z0-9._-]{0,99}';

/** Listmonk-side route patterns (path-to-regexp syntax, as next.config `source`), without the prefix. */
export const LISTMONK_PROXY_PATTERNS: readonly string[] = Object.freeze([
  `/link/:link(${UUID})/:camp(${UUID})/:sub(${UUID})`,
  `/campaign/:camp(${UUID})/:sub(${UUID})/px\\.png`,
  `/subscription/:camp(${UUID})/:sub(${UUID})`,
  `/public/static/:file(${FILE})`,
  '/public/custom\\.css',
  '/public/custom\\.js',
]);

/** The subset of the patterns the unsubscribe page requests with an absolute path (also proxied without /lm). */
export const LISTMONK_ASSET_PATTERNS: readonly string[] = Object.freeze(LISTMONK_PROXY_PATTERNS.filter((p) => p.startsWith('/public/')));

export interface ProxyRewrite {
  source: string;
  destination: string;
}

/** `/x/:a(re)/y` → `/x/:a/y` (a destination keeps the parameter names, not their constraints). */
function withoutConstraints(pattern: string): string {
  return pattern.replace(/(:[A-Za-z]+)\([^)]*\)/g, '$1').replace(/\\\./g, '.');
}

/** The rewrite list for a target such as `http://listmonk:9000` (trailing slashes ignored). */
export function listmonkProxyRewrites(target: string): ProxyRewrite[] {
  const base = target.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/\s]+$/.test(base)) throw new Error(`BLOG0_LM_PROXY_TARGET must be an http(s) origin without a path, got "${target}"`);
  const sources = [...LISTMONK_PROXY_PATTERNS.map((p) => [`${LISTMONK_PROXY_PREFIX}${p}`, p] as const), ...LISTMONK_ASSET_PATTERNS.map((p) => [p, p] as const)];
  return sources.map(([source, p]) => ({ source, destination: `${base}${withoutConstraints(p)}` }));
}

/**
 * Build-time switch: the proxy target when enabled, else null (no rewrites; local dev/tests are unchanged).
 * Enabled by BLOG0_LM_PROXY_TARGET, or by BLOG0_STANDALONE=1 (the image build) → http://listmonk:9000.
 */
export function listmonkProxyTarget(env: Record<string, string | undefined> = process.env): string | null {
  const explicit = (env.BLOG0_LM_PROXY_TARGET ?? '').trim();
  if (explicit !== '') return explicit;
  return env.BLOG0_STANDALONE === '1' ? LISTMONK_PROXY_DEFAULT_TARGET : null;
}

const PATH_REGEXES: readonly RegExp[] = [
  ...LISTMONK_PROXY_PATTERNS.map((p) => `${LISTMONK_PROXY_PREFIX}${p}`),
  ...LISTMONK_ASSET_PATTERNS,
].map((source) => new RegExp(`^${source.replace(/:[A-Za-z]+\(((?:[^()\\]|\\.)*)\)/g, '($1)')}$`));

/** True when `pathname` is one of the allow-listed public Listmonk paths (same rules as the rewrites). */
export function isListmonkProxyPath(pathname: string): boolean {
  return PATH_REGEXES.some((re) => re.test(pathname));
}
