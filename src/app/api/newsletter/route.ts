import type { NewsletterSubscribeResponse } from '@/lib/api/dto';
import { clientIpFromRequest } from '@/server/auth/login';
import { ApiError, withApi } from '@/server/http/api';
import { log, maskEmail } from '@/server/log';
import { botDropReason } from '@/server/newsletter/bot-check';
import { getNewsletterThrottle } from '@/server/newsletter/rate-limit';
import { subscribeBody } from '@/server/newsletter/schemas';
import { requestContextFrom, signupDelivery, subscribe } from '@/server/newsletter/service';
import { getCurrentSite } from '@/server/site/current';

// POST /api/newsletter — { email, name?, sourceUrl?, website?, fillMs? } → { subscribed: true, delivery }
// (spec/api.md, capability newsletter-list). Public, same-origin only (403 FORBIDDEN_ORIGIN), 400
// VALIDATION_FAILED on a bad body (never counted). Stage A bot drop, after validation and BEFORE any
// rate-limit counting: a filled honeypot `website` or a fill time under 2 s (or none) → the same
// success-shaped 200, nothing written, one `newsletter.signup_dropped` line. Then 429 RATE_LIMITED
// (+ Retry-After) past any cap: 10 / known client IP / hour, 3 / email / hour, 300 / site / hour.
// Phase 7: creates or re-opens a `pending` subscriber with the consent shown under the form and sends
// ONE confirmation email (double opt-in). Stage A `delivery`: `failed` only when this request's SMTP
// send was rejected; otherwise `sent` (SMTP) / `recorded` (stub) for a new, pending, confirmed,
// capped or suppressed address alike (no enumeration).

export const dynamic = 'force-dynamic';

export const POST = withApi(
  {
    auth: 'none',
    body: subscribeBody,
    summarizeInput: (body) => ({ email_masked: maskEmail(body.email), hasName: body.name !== null, sourceUrlChars: body.sourceUrl.length }),
  },
  async ({ request, requestId, body }): Promise<NewsletterSubscribeResponse> => {
    const dropped = botDropReason(body);
    if (dropped !== null) {
      log.info('newsletter.signup_dropped', { msg: `Signup dropped (${dropped})`, request_id: requestId, reason: dropped, source_url: body.sourceUrl });
      return { subscribed: true, delivery: signupDelivery(null) };
    }
    const site = await getCurrentSite();
    const ip = clientIpFromRequest(request);
    const check = await getNewsletterThrottle().attempt({ ip, email: body.email, siteId: site.id });
    if (check.limited) {
      throw new ApiError('RATE_LIMITED', 429, 'Too many signups right now — try again later.', undefined, {
        'retry-after': String(check.retryAfterSec),
      });
    }
    const result = await subscribe({ ...requestContextFrom(request, ip), requestId }, body, site);
    return { subscribed: true, delivery: signupDelivery(result) };
  },
);
