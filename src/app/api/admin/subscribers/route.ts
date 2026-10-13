import type { NewsletterAuditBundle, SubscriberListResponse } from '@/lib/api/dto';
import { ApiError, apiResult, withApi } from '@/server/http/api';
import { buildAuditBundle, subscribersToCsv } from '@/server/newsletter/audit';
import { subscriberListQuery } from '@/server/newsletter/schemas';
import { listSubscribers } from '@/server/newsletter/service';
import { getCurrentSite } from '@/server/site/current';

// GET /api/admin/subscribers (spec/api.md → newsletter): `?status=` `&q=` filter the list
// (SubscriberListResponse, newest first, with counts per status); `?format=csv` downloads the
// filtered rows; `?format=audit` downloads the whole proof bundle (filters ignored). 401 without a session.

export const dynamic = 'force-dynamic';

/** YYYY-MM-DD in the site's time zone (falls back to UTC on an unknown zone). */
function dateStamp(timeZone: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

function queryOf(request: Request) {
  const params = new URL(request.url).searchParams;
  const parsed = subscriberListQuery.safeParse({
    status: params.get('status') ?? undefined,
    q: params.get('q') ?? undefined,
    format: params.get('format') ?? undefined,
  });
  if (!parsed.success) throw new ApiError('VALIDATION_FAILED', 400, 'Unknown status or format.', { query: Object.fromEntries(params) });
  return parsed.data;
}

export const GET = withApi(
  {
    auth: 'admin',
    summarizeInput: (_body, request) => {
      const p = new URL(request.url).searchParams;
      return { format: p.get('format') ?? 'json', status: p.get('status') ?? 'all', hasQuery: p.has('q') };
    },
    summarizeOutput: (d) => {
      const list = d as Partial<SubscriberListResponse> & Partial<NewsletterAuditBundle>;
      return { subscribers: list.subscribers?.length ?? 0 };
    },
  },
  async ({ auth, request }) => {
    const query = queryOf(request);
    const site = await getCurrentSite();
    const safeSlug = site.slug.replace(/[^A-Za-z0-9_-]/g, '') || 'site';
    const stamp = dateStamp(site.timezone);

    if (query.format === 'audit') {
      const bundle = await buildAuditBundle(site, { email: auth.user.email });
      return apiResult(bundle, {
        body: JSON.stringify(bundle, null, 2),
        headers: [
          ['content-type', 'application/json; charset=utf-8'],
          ['content-disposition', `attachment; filename="${safeSlug}-newsletter-audit-${stamp}.json"`],
        ],
      });
    }

    const list = await listSubscribers(auth.user.siteId, { status: query.status, q: query.q });
    if (query.format !== 'csv') return list;
    return apiResult(list, {
      body: subscribersToCsv(list.subscribers),
      headers: [
        ['content-type', 'text/csv; charset=utf-8'],
        ['content-disposition', `attachment; filename="${safeSlug}-subscribers-${stamp}.csv"`],
      ],
    });
  },
);
