import type { SendConfirmationResponse } from '@/lib/api/dto';
import { ApiError, withApi } from '@/server/http/api';
import { sendLegacyConfirmation } from '@/server/newsletter/legacy';
import { findSubscriberById, getSubscriberDetail, resendConfirmation } from '@/server/newsletter/service';

import { subscriberIdOf } from '../route';

// POST /api/admin/subscribers/:id/send-confirmation (spec/api.md → newsletter). Legacy row: its ONE
// email (then CONFIRMATION_ALREADY_SENT); pending row: a new token + email under the 3-per-24 h cap
// (CONFIRMATION_ALREADY_SENT with details.retryAt beyond it); any other status →
// SUBSCRIBER_NOT_ELIGIBLE; MAIL_FAILED when SMTP rejects (nothing else changes).

export const dynamic = 'force-dynamic';

export const POST = withApi(
  { auth: 'admin', summarizeOutput: (d) => ({ transport: (d as SendConfirmationResponse).transport }) },
  async ({ auth, params }): Promise<SendConfirmationResponse> => {
    const id = subscriberIdOf(params);
    const row = await findSubscriberById(auth.user.siteId, id);
    if (!row) throw new ApiError('NOT_FOUND', 404, 'That subscriber isn’t here.');
    const actor = { userId: auth.user.id };
    let result;
    if (row.status === 'legacy_unconfirmed') result = await sendLegacyConfirmation(auth.user.siteId, row, actor);
    else if (row.status === 'pending') result = await resendConfirmation(auth.user.siteId, row, actor);
    else throw new ApiError('SUBSCRIBER_NOT_ELIGIBLE', 409, `A ${row.status} subscriber can’t be sent a confirmation.`);
    return { subscriber: await getSubscriberDetail(auth.user.siteId, id), sentTo: result.sentTo, transport: result.transport };
  },
);
