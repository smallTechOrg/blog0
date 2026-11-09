import type { SubscriberDetailResponse } from '@/lib/api/dto';
import { ApiError, withApi } from '@/server/http/api';
import { getSubscriberDetail } from '@/server/newsletter/service';

// GET /api/admin/subscribers/:id — the per-subscriber audit view: every stored field, the full
// event timeline, the suppression rows for that email, the messages (spec/api.md → newsletter).

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f-]{36}$/i;

export function subscriberIdOf(params: Record<string, string | string[] | undefined>): string {
  const id = typeof params.id === 'string' ? params.id : '';
  if (!UUID_RE.test(id)) throw new ApiError('NOT_FOUND', 404, 'That subscriber isn’t here.');
  return id;
}

export const GET = withApi(
  { auth: 'admin', summarizeOutput: (d) => ({ events: (d as SubscriberDetailResponse).subscriber.events.length }) },
  async ({ auth, params }): Promise<SubscriberDetailResponse> => ({
    subscriber: await getSubscriberDetail(auth.user.siteId, subscriberIdOf(params)),
  }),
);
