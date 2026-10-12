import { NextResponse, type NextRequest } from 'next/server';

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

export const config = {
  matcher: ['/p/:slug', '/p/:slug/tldr'],
};

/** An internal path no route matches, so the root not-found renders with a 404 status. */
export const ARTICLE_NOT_FOUND_PATH = '/_blog0/article-not-found';

export function slugFromArticlePath(pathname: string): string | null {
  const m = /^\/p\/([^/]+)(?:\/tldr)?\/?$/.exec(pathname);
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

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const slug = slugFromArticlePath(request.nextUrl.pathname);
  if (slug === null) return NextResponse.next();

  let exists: boolean;
  try {
    exists = await publishedSlugExists(slug);
  } catch (err) {
    // DB or site lookup failed: log (spec/architecture.md §8) and let the page render path decide
    // (it surfaces the error properly). Never log the raw slug or the error text (it can carry
    // connection details) — only the matched route shape and a machine error code.
    log.warn('proxy.slug_check_failed', {
      msg: 'Published-slug pre-check failed; falling through to the page',
      path: /\/tldr\/?$/.test(request.nextUrl.pathname) ? '/p/:slug/tldr' : '/p/:slug',
      err_code: errorCode(err),
    });
    return NextResponse.next();
  }
  if (exists) return NextResponse.next();

  const target = request.nextUrl.clone();
  target.pathname = ARTICLE_NOT_FOUND_PATH;
  return NextResponse.rewrite(target);
}
