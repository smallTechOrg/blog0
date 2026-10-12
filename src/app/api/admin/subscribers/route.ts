import type { SubscriberListResponse } from '@/lib/api/dto';
import { apiResult, withApi } from '@/server/http/api';
import { listSubscribers, subscribersToCsv } from '@/server/newsletter/service';
import { getCurrentSite } from '@/server/site/current';

// GET /api/admin/subscribers — { subscribers: [{ email, name, createdAt, status }], total }
// (newest first, current site only). `?format=csv` answers a CSV download instead (header row
// email,name,subscribed_at,status). 401 UNAUTHENTICATED without a session.

export const dynamic = 'force-dynamic';

const isCsv = (request: Request) => new URL(request.url).searchParams.get('format') === 'csv';

/** YYYY-MM-DD in the site's time zone (falls back to UTC on an unknown zone). */
function dateStamp(timeZone: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export const GET = withApi(
  {
    auth: 'admin',
    summarizeInput: (_body, request) => (isCsv(request) ? { format: 'csv' } : {}),
    summarizeOutput: (d) => ({ subscribers: (d as SubscriberListResponse).subscribers.length }),
  },
  async ({ auth, request }) => {
    const list = await listSubscribers(auth.user.siteId);
    if (!isCsv(request)) return list;
    const site = await getCurrentSite();
    const safeSlug = site.slug.replace(/[^A-Za-z0-9_-]/g, '') || 'site';
    return apiResult(list, {
      body: subscribersToCsv(list.subscribers),
      headers: [
        ['content-type', 'text/csv; charset=utf-8'],
        ['content-disposition', `attachment; filename="${safeSlug}-subscribers-${dateStamp(site.timezone)}.csv"`],
      ],
    });
  },
);
