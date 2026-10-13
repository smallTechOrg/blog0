import type { NewsletterSubscribeResponse } from '@/lib/api/dto';
import { clientIpFromRequest } from '@/server/auth/login';
import { ApiError, withApi } from '@/server/http/api';
import { maskEmail } from '@/server/log';
import { getNewsletterThrottle } from '@/server/newsletter/rate-limit';
import { subscribeBody } from '@/server/newsletter/schemas';
import { requestContextFrom, subscribe } from '@/server/newsletter/service';
import { getCurrentSite } from '@/server/site/current';

// POST /api/newsletter — { email, name?, sourceUrl? } → { subscribed: true } (spec/api.md, capability
// newsletter-list). Public, same-origin only (403 FORBIDDEN_ORIGIN), 400 VALIDATION_FAILED on a bad
// body (never counted), 429 RATE_LIMITED (+ Retry-After) past any cap: 10 / known client IP / hour,
// 3 / email / hour, 300 / site / hour. Phase 7: creates or re-opens a `pending` subscriber with the
// consent shown under the form and sends ONE confirmation email (double opt-in); the same success is
// returned for a new, pending, confirmed or suppressed address (no enumeration).

export const dynamic = 'force-dynamic';

export const POST = withApi(
  {
    auth: 'none',
    body: subscribeBody,
    summarizeInput: (body) => ({ email_masked: maskEmail(body.email), hasName: body.name !== null, sourceUrlChars: body.sourceUrl.length }),
  },
  async ({ request, requestId, body }): Promise<NewsletterSubscribeResponse> => {
    const site = await getCurrentSite();
    const ip = clientIpFromRequest(request);
    const check = await getNewsletterThrottle().attempt({ ip, email: body.email, siteId: site.id });
    if (check.limited) {
      throw new ApiError('RATE_LIMITED', 429, 'Too many signups right now — try again later.', undefined, {
        'retry-after': String(check.retryAfterSec),
      });
    }
    await subscribe({ ...requestContextFrom(request, ip), requestId }, body, site);
    return { subscribed: true };
  },
);
