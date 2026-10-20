import type { AdminUnsubscribeResponse } from '@/lib/api/dto';
import { withApi } from '@/server/http/api';
import { adminUnsubscribeBody } from '@/server/newsletter/schemas';
import { adminUnsubscribe, getSubscriberDetail } from '@/server/newsletter/service';

import { subscriberIdOf } from '../route';

// POST /api/admin/subscribers/:id/unsubscribe { note? } — an admin-sourced suppression
// (reason `admin`, source `admin`), status `unsubscribed`; already suppressed → SUBSCRIBER_NOT_ELIGIBLE.

export const dynamic = 'force-dynamic';

export const POST = withApi(
  { auth: 'admin', body: adminUnsubscribeBody, summarizeInput: (b) => ({ hasNote: b.note !== undefined }) },
  async ({ auth, params, body }): Promise<AdminUnsubscribeResponse> => {
    const id = subscriberIdOf(params);
    await adminUnsubscribe(auth.user.siteId, id, { userId: auth.user.id }, body.note);
    return { subscriber: await getSubscriberDetail(auth.user.siteId, id) };
  },
);
