import { withApi, type RouteContext } from '@/server/http/api';
import { subscribersCsvResponse } from '@/server/newsletter/http';
import { listSubscribers } from '@/server/newsletter/service';
import type { SubscriberListResponse } from '@/server/newsletter/types';

// GET /api/admin/subscribers — { subscribers: [{ email, name, createdAt, status }], total }
// (newest first, current site only). `?format=csv` answers a CSV download instead (header row
// email,name,subscribed_at,status). 401 UNAUTHENTICATED without a session.

export const dynamic = 'force-dynamic';

const getJson = withApi(
  { auth: 'admin', summarizeOutput: (d) => ({ subscribers: (d as SubscriberListResponse).subscribers.length }) },
  async ({ auth }): Promise<SubscriberListResponse> => listSubscribers(auth.user.siteId),
);

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const format = new URL(request.url).searchParams.get('format');
  if (format === 'csv') return subscribersCsvResponse(request);
  return getJson(request, context);
}
