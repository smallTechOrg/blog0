import type { NewsletterUnsubscribeResponse } from '@/lib/api/dto';
import { clientIpFromRequest } from '@/server/auth/login';
import { ApiError, withApi } from '@/server/http/api';
import { log } from '@/server/log';
import { throttleLink } from '@/server/newsletter/link-guard';
import { requestContextFrom, unsubscribeByToken } from '@/server/newsletter/service';
import { isWellFormedUnsubscribeToken } from '@/server/newsletter/tokens';
import { getCurrentSite } from '@/server/site/current';

// POST /api/newsletter/unsubscribe (spec/api.md): JSON { token } OR the RFC 8058 one-click form
// (`List-Unsubscribe=One-Click` form-encoded, token in `?t=`) → { unsubscribed: true,
// alreadyUnsubscribed }. No CSRF check (mail providers post here with no Origin). TOKEN_INVALID (404)
// on a bad signature, RATE_LIMITED (429) past the link cap; idempotent for an already-suppressed address.

export const dynamic = 'force-dynamic';

const NOINDEX = { 'x-robots-tag': 'noindex' };

/** The token from a JSON body, a form body, or the `t` query parameter (one-click). */
async function tokenFrom(request: Request): Promise<string | null> {
  const url = new URL(request.url);
  const type = (request.headers.get('content-type') ?? '').toLowerCase();
  const text = await request.text();
  if (type.startsWith('application/json') || (text.trim().startsWith('{') && !type.startsWith('application/x-www-form-urlencoded'))) {
    let raw: unknown;
    try {
      raw = text.trim() === '' ? {} : JSON.parse(text);
    } catch {
      throw new ApiError('VALIDATION_FAILED', 400, 'The request body is not valid JSON.');
    }
    const token = (raw as { token?: unknown } | null)?.token;
    if (typeof token === 'string' && token.trim()) return token.trim();
  }
  if (type.startsWith('application/x-www-form-urlencoded') || type.startsWith('multipart/form-data')) {
    const params = type.startsWith('multipart/form-data') ? null : new URLSearchParams(text);
    const fromForm = params?.get('token') ?? params?.get('t');
    if (fromForm && fromForm.trim()) return fromForm.trim();
  }
  const fromQuery = url.searchParams.get('t');
  return fromQuery && fromQuery.trim() ? fromQuery.trim() : null;
}

export const POST = withApi(
  { auth: 'none', csrf: false, summarizeInput: (_b, request) => ({ oneClick: (request.headers.get('content-type') ?? '').includes('form') }) },
  async ({ request, requestId }): Promise<NewsletterUnsubscribeResponse> => {
    const oneClick = !(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json');
    const token = await tokenFrom(request);
    if (!isWellFormedUnsubscribeToken(token)) throw new ApiError('TOKEN_INVALID', 404, 'That link isn’t valid.', undefined, NOINDEX);
    const site = await getCurrentSite();
    const ip = clientIpFromRequest(request);
    const kind = oneClick ? 'one_click' : 'unsubscribe';
    await throttleLink({ ip, siteId: site.id }, requestId, kind);
    try {
      const result = await unsubscribeByToken(token, kind === 'one_click' ? 'one_click' : 'email_link', { ...requestContextFrom(request, ip), requestId }, site);
      log.info('newsletter.link', { request_id: requestId, kind, outcome: result.alreadyUnsubscribed ? 'already' : 'ok', subscriber_id: result.subscriber.id });
      return { unsubscribed: true, alreadyUnsubscribed: result.alreadyUnsubscribed };
    } catch (err) {
      if (err instanceof ApiError && err.code === 'TOKEN_INVALID') {
        log.info('newsletter.link', { request_id: requestId, kind, outcome: 'invalid' });
        throw new ApiError(err.code, err.status, err.message, err.details, NOINDEX);
      }
      throw err;
    }
  },
);
