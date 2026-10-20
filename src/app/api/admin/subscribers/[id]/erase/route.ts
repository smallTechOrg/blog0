import type { SubscriberEraseResponse } from '@/lib/api/dto';
import { withApi } from '@/server/http/api';
import { eraseSubscriber } from '@/server/newsletter/erase';
import { eraseBody } from '@/server/newsletter/schemas';

import { subscriberIdOf } from '../route';

// POST /api/admin/subscribers/:id/erase { confirmEmail } (owner decision 2026-10-19) — DELETES the
// subscriber and every row holding its data via `newsletter_erase_subscriber` (migration
// 0005_newsletter_erase_delete; a hashed marker + a PII-free audit row stay), then deletes the Listmonk
// copy. `confirmEmail` must equal the subscriber's address (else 400 VALIDATION_FAILED); unknown or
// already deleted → 404; the database refusing → 500 ERASE_FAILED naming why. The log line carries no address.

export const dynamic = 'force-dynamic';

export const POST = withApi(
  { auth: 'admin', body: eraseBody, summarizeInput: () => ({}), summarizeOutput: (d) => ({ provider: (d as SubscriberEraseResponse).provider, erasureId: (d as SubscriberEraseResponse).erasureId }) },
  async ({ auth, params, body, requestId }): Promise<SubscriberEraseResponse> =>
    eraseSubscriber(auth.user.siteId, subscriberIdOf(params), { confirmEmail: body.confirmEmail }, { userId: auth.user.id, requestId }),
);
