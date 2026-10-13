import { randomBytes } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';

import { isHttpsOrigin, runtimeSecurityHeaders } from '@/lib/http/csp';
import { getConfig } from '@/server/config';
import { log } from '@/server/log';
import { publishedSlugExists } from '@/server/public/articles';

// Article 404s with the site chrome in the SERVER HTML.
//
// A `notFound()` thrown from the /p/[slug] page reaches React's SSR shell with no error boundary
// (Fizz has none), so Next 16 answers 404 with its bare `__next_error__` shell and the masthead,
// footer and "That article isn't here" only appear after client JS. An unmatched URL, by
// contrast, renders the root not-found (src/app/not-found.tsx: site chrome + message) as a page.
// So unknown, malformed and unpublished slugs are rewritten here to an unmatched internal path:
// the reader keeps the /p/<slug> address and gets a real 404 with the full chrome server-rendered.
// The page's own notFound() stays as the fallback (e.g. an article unpublished between the two reads).
//
// Per-request CSP nonce (Phase 5, spec/architecture.md §6), production server only (`pnpm start` /
// the container; never `pnpm dev` / designer mode, so HMR and the error overlay keep working): a
// fresh nonce goes on the request as `x-nonce` + `content-security-policy` (Next 16 reads the nonce
// from the request CSP and stamps its own scripts; the root layout reads `x-nonce` for the theme
// script) and the same CSP (+ HSTS over https) on the response. Prefetches, API, static assets and
// /media are not matched (except the article paths, matched as before).

export const config = {
  matcher: [
    '/p/:slug',
    '/p/:slug/tldr',
    '/p/:slug/listen',
    {
      source: '/((?!api/|_next/|media/|favicon.ico|robots.txt|sitemap.xml).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};

/** An internal path no route matches, so the root not-found renders with a 404 status. */
export const ARTICLE_NOT_FOUND_PATH = '/_blog0/article-not-found';

export function slugFromArticlePath(pathname: string): string | null {
  const m = /^\/p\/([^/]+)(?:\/tldr|\/listen)?\/?$/.exec(pathname);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/** A safe, non-identifying code for a failed check: the driver's error code or the error class name. */
export function errorCode(err: unknown): string {
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(code)) return code;
    if (err instanceof Error && /^[A-Za-z]{1,40}$/.test(err.name)) return err.name;
  }
  return 'unknown';
}

/** The matched route shape for the failure log (never the slug itself). */
function routeShape(pathname: string): string {
  if (/\/tldr\/?$/.test(pathname)) return '/p/:slug/tldr';
  if (/\/listen\/?$/.test(pathname)) return '/p/:slug/listen';
  return '/p/:slug';
}

interface PageSecurity {
  requestHeaders: Headers;
  responseHeaders: Record<string, string>;
}

/** The nonce'd request + response headers in production; null in development/test (no CSP). */
export function pageSecurity(request: NextRequest, nodeEnv: string | undefined = process.env.NODE_ENV): PageSecurity | null {
  if (nodeEnv !== 'production') return null;
  const nonce = randomBytes(16).toString('base64');
  const responseHeaders = runtimeSecurityHeaders({ nonce, https: isHttpsOrigin(getConfig().publicBaseUrl) });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', responseHeaders['content-security-policy']);
  return { requestHeaders, responseHeaders };
}

function withSecurity(response: NextResponse, security: PageSecurity | null): NextResponse {
  if (security) for (const [name, value] of Object.entries(security.responseHeaders)) response.headers.set(name, value);
  return response;
}

function next(security: PageSecurity | null): NextResponse {
  return withSecurity(security ? NextResponse.next({ request: { headers: security.requestHeaders } }) : NextResponse.next(), security);
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const security = pageSecurity(request);
  const slug = slugFromArticlePath(request.nextUrl.pathname);
  if (slug === null) return next(security);

  let exists: boolean;
  try {
    exists = await publishedSlugExists(slug);
  } catch (err) {
    // DB or site lookup failed: log (spec/architecture.md §8) and let the page render path decide
    // (it surfaces the error properly). Never log the raw slug or the error text (it can carry
    // connection details) — only the matched route shape and a machine error code.
    log.warn('proxy.slug_check_failed', {
      msg: 'Published-slug pre-check failed; falling through to the page',
      path: routeShape(request.nextUrl.pathname),
      err_code: errorCode(err),
    });
    return next(security);
  }
  if (exists) return next(security);

  const target = request.nextUrl.clone();
  target.pathname = ARTICLE_NOT_FOUND_PATH;
  return withSecurity(
    security ? NextResponse.rewrite(target, { request: { headers: security.requestHeaders } }) : NextResponse.rewrite(target),
    security,
  );
}
