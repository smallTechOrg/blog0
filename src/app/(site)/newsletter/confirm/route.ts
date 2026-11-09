import { clientIpFromRequest } from '@/server/auth/login';
import { ApiError, requestIdFor } from '@/server/http/api';
import { log } from '@/server/log';
import { checkLink } from '@/server/newsletter/link-guard';
import { confirmResultLocation, type ConfirmResultStatus } from '@/server/newsletter/links';
import { confirmByToken, requestContextFrom } from '@/server/newsletter/service';
import { isWellFormedConfirmToken } from '@/server/newsletter/tokens';
import { getCurrentSite } from '@/server/site/current';

// GET /newsletter/confirm?t=<token> — the emailed link (spec/api.md → newsletter; spec/ui.md §3).
// Confirm-on-open (owner decision 2026-10-19, supersedes the scanner-safe button): opening the link
// confirms, like Mailchimp/Substack. A route handler, not a page, so the state change never runs
// inside React rendering. Same path as before, so already-sent links keep working. It runs exactly
// what POST /api/newsletter/confirm runs — shape check (malformed → invalid, never counted), the
// shared link cap, `confirmByToken` with IP + user agent + request id — plus `details.via:
// 'link_open'` on the event, then 303s to /newsletter/confirmed?status=ok|already|expired|invalid|
// limited. A spent token whose subscriber is still confirmed is "already", never an error.

export const dynamic = 'force-dynamic';

function redirectTo(status: ConfirmResultStatus, minutes?: number): Response {
  return new Response(null, {
    status: 303,
    headers: { location: confirmResultLocation(status, minutes), 'cache-control': 'no-store', 'x-robots-tag': 'noindex', 'referrer-policy': 'no-referrer' },
  });
}

export async function GET(request: Request): Promise<Response> {
  const requestId = requestIdFor(request);
  const token = (new URL(request.url).searchParams.get('t') ?? '').trim();
  if (!isWellFormedConfirmToken(token)) {
    log.info('newsletter.link', { request_id: requestId, kind: 'confirm', via: 'link_open', outcome: 'invalid' });
    return redirectTo('invalid');
  }
  const site = await getCurrentSite();
  const ip = clientIpFromRequest(request);
  const check = await checkLink({ ip, siteId: site.id });
  if (check.limited) {
    log.info('newsletter.link', { request_id: requestId, kind: 'confirm', via: 'link_open', outcome: 'rate_limited' });
    return redirectTo('limited', check.retryMinutes);
  }
  try {
    const result = await confirmByToken(token, { ...requestContextFrom(request, ip), requestId }, site, { via: 'link_open', usedAsAlready: true });
    const outcome = result.alreadyConfirmed ? 'already' : 'ok';
    log.info('newsletter.link', { request_id: requestId, kind: 'confirm', via: 'link_open', outcome, subscriber_id: result.subscriber.id });
    return redirectTo(outcome);
  } catch (err) {
    if (err instanceof ApiError && (err.code === 'TOKEN_INVALID' || err.code === 'TOKEN_EXPIRED')) {
      const outcome = err.code === 'TOKEN_EXPIRED' ? 'expired' : 'invalid';
      log.info('newsletter.link', { request_id: requestId, kind: 'confirm', via: 'link_open', outcome });
      return redirectTo(outcome);
    }
    throw err;
  }
}
