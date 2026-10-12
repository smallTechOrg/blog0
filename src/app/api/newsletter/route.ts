import { clientIpFromRequest } from '@/server/auth/login';
import { ApiError, withApi } from '@/server/http/api';
import { maskEmail } from '@/server/log';
import { getNewsletterThrottle } from '@/server/newsletter/rate-limit';
import { subscribe, subscribeBody } from '@/server/newsletter/service';
import type { NewsletterSubscribeResponse } from '@/server/newsletter/types';
import { getCurrentSite } from '@/server/site/current';

// POST /api/newsletter — { email, name? } → { subscribed: true } (spec/api.md, capability
// newsletter-signup). Public, same-origin only (403 FORBIDDEN_ORIGIN), 400 VALIDATION_FAILED on a
// bad address, 429 RATE_LIMITED (+ Retry-After) past any cap: 10 / known client IP / hour (skipped
// when the IP is unknown, e.g. BLOG0_TRUSTED_PROXY_HOPS=0), 3 / email / hour, 300 / site / hour.
// Only validated requests are counted. The same success is returned whether or not the address
// already existed (no enumeration).

export const dynamic = 'force-dynamic';

export const POST = withApi(
  {
    auth: 'none',
    body: subscribeBody,
    summarizeInput: (body) => ({ email_masked: maskEmail(body.email), hasName: body.name !== null }),
  },
  async ({ request, body }): Promise<NewsletterSubscribeResponse> => {
    const site = await getCurrentSite();
    const check = getNewsletterThrottle().attempt({ ip: clientIpFromRequest(request), email: body.email, siteId: site.id });
    if (check.limited) {
      throw new ApiError('RATE_LIMITED', 429, 'Too many signups right now — try again later.', undefined, {
        'retry-after': String(check.retryAfterSec),
      });
    }
    await subscribe(site.id, body);
    return { subscribed: true };
  },
);
