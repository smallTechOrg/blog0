import type { SubscriberEraseResponse } from '@/lib/api/dto';
import { withApi } from '@/server/http/api';
import { eraseSubscriber } from '@/server/newsletter/erase';
import { eraseBody } from '@/server/newsletter/schemas';

import { subscriberIdOf } from '../route';

// POST /api/admin/subscribers/:id/erase { confirmEmail } (fix pass) — redacts the subscriber's personal
// data via `newsletter_erase_subscriber` (migration 0004_newsletter_erasure) and removes the provider
// copy best-effort. `confirmEmail` must equal the subscriber's address (else 400 VALIDATION_FAILED);
// already erased → 409 SUBSCRIBER_NOT_ELIGIBLE; unknown id → 404. The log line carries no address.

export const dynamic = 'force-dynamic';

export const POST = withApi(
  { auth: 'admin', body: eraseBody, summarizeInput: () => ({}), summarizeOutput: (d) => ({ providerRemoved: (d as SubscriberEraseResponse).providerRemoved }) },
  async ({ auth, params, body, requestId }): Promise<SubscriberEraseResponse> =>
    eraseSubscriber(auth.user.siteId, subscriberIdOf(params), { confirmEmail: body.confirmEmail }, { userId: auth.user.id, requestId }),
);
