import type { NewsletterConfirmResponse } from '@/lib/api/dto';
import { clientIpFromRequest } from '@/server/auth/login';
import { ApiError, withApi } from '@/server/http/api';
import { log } from '@/server/log';
import { confirmBody } from '@/server/newsletter/schemas';
import { confirmByToken, requestContextFrom } from '@/server/newsletter/service';
import { isWellFormedConfirmToken } from '@/server/newsletter/tokens';
import { throttleLink } from '@/server/newsletter/link-guard';
import { getCurrentSite } from '@/server/site/current';

// POST /api/newsletter/confirm — { token } → { confirmed: true, alreadyConfirmed } (spec/api.md).
// No CSRF check: the token is the authority. TOKEN_INVALID (404), TOKEN_EXPIRED (410), RATE_LIMITED
// (429, after the shape check — a malformed token is never counted). Used by tests and a future JS
// fallback; the HTML page (/newsletter/confirm) calls the service directly.

export const dynamic = 'force-dynamic';

const LINK_HEADERS: Array<[string, string]> = [['x-robots-tag', 'noindex']];

export const POST = withApi(
  { auth: 'none', csrf: false, body: confirmBody, summarizeInput: (b) => ({ tokenChars: b.token.length }) },
  async ({ request, requestId, body }): Promise<NewsletterConfirmResponse> => {
    if (!isWellFormedConfirmToken(body.token)) throw new ApiError('TOKEN_INVALID', 404, 'That link isn’t valid.', undefined, headersOf());
    const site = await getCurrentSite();
    const ip = clientIpFromRequest(request);
    await throttleLink({ ip, siteId: site.id }, requestId, 'confirm');
    try {
      const result = await confirmByToken(body.token, { ...requestContextFrom(request, ip), requestId }, site);
      log.info('newsletter.link', { request_id: requestId, kind: 'confirm', outcome: 'ok', subscriber_id: result.subscriber.id });
      return { confirmed: true, alreadyConfirmed: result.alreadyConfirmed };
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'TOKEN_INVALID' || err.code === 'TOKEN_EXPIRED')) {
        log.info('newsletter.link', { request_id: requestId, kind: 'confirm', outcome: err.code === 'TOKEN_EXPIRED' ? 'expired' : 'invalid' });
        throw new ApiError(err.code, err.status, err.message, err.details, headersOf());
      }
      throw err;
    }
  },
);

function headersOf(): Record<string, string> {
  return Object.fromEntries(LINK_HEADERS);
}
