import type { SendLegacyConfirmationsResponse } from '@/lib/api/dto';
import { withApi } from '@/server/http/api';
import { sendAllLegacyConfirmations } from '@/server/newsletter/legacy';
import { confirmTrueBody } from '@/server/newsletter/schemas';

// POST /api/admin/subscribers/send-legacy-confirmations { confirm: true } → { sent, skipped }:
// one email per legacy_unconfirmed row not yet mailed (each row's one-time rule), batches of 20
// with a 200 ms pause; a mail failure skips that row. Nothing happens without confirm: true (400).

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export const POST = withApi(
  { auth: 'admin', body: confirmTrueBody, summarizeOutput: (d) => d as unknown as Record<string, unknown> },
  async ({ auth }): Promise<SendLegacyConfirmationsResponse> => sendAllLegacyConfirmations(auth.user.siteId, { userId: auth.user.id }),
);
