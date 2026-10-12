import 'server-only';

import { randomUUID } from 'node:crypto';

import { errEnvelope } from '@/lib/api/envelope';

import { requireAdmin } from '../auth/guard';
import { ApiError } from '../http/api';
import { log } from '../log';
import { getCurrentSite } from '../site/current';
import { listSubscribers, subscribersToCsv } from './service';

// GET /api/admin/subscribers?format=csv — the one admin route that answers with a file instead of
// the JSON envelope, so it sits beside withApi() (which always emits JSON). Same guard, same error
// envelope on failure, same single `api.request` log line.

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,80}$/;

/** YYYY-MM-DD in the site's time zone (falls back to UTC on an unknown zone). */
function dateStamp(timeZone: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export async function subscribersCsvResponse(request: Request): Promise<Response> {
  const started = performance.now();
  const incoming = request.headers.get('x-request-id');
  const requestId = incoming && REQUEST_ID_RE.test(incoming) ? incoming : randomUUID();
  const path = new URL(request.url).pathname;
  let status = 200;
  let userId: string | undefined;
  let errCode: string | undefined;
  let rows = 0;
  let response: Response;
  try {
    const auth = await requireAdmin(request);
    userId = auth.user.id;
    const site = await getCurrentSite();
    const safeSlug = site.slug.replace(/[^A-Za-z0-9_-]/g, '') || 'site';
    const list = await listSubscribers(auth.user.siteId);
    rows = list.subscribers.length;
    const headers = new Headers({
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${safeSlug}-subscribers-${dateStamp(site.timezone)}.csv"`,
      'cache-control': 'no-store',
      'x-request-id': requestId,
    });
    if (auth.setCookie) headers.append('set-cookie', auth.setCookie);
    response = new Response(subscribersToCsv(list.subscribers), { status, headers });
  } catch (error) {
    const known = error instanceof ApiError ? error : null;
    status = known?.status ?? 500;
    errCode = known?.code ?? 'INTERNAL';
    if (!known) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error('error', { msg: 'Unhandled error in API route', request_id: requestId, method: 'GET', path, err_message: err.message });
    }
    const message = known?.message ?? 'Something went wrong on our side. Try again; if it keeps happening, check the server log.';
    response = new Response(JSON.stringify(errEnvelope(errCode, message, requestId)), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-request-id': requestId },
    });
  }
  log.info('api.request', {
    msg: `GET ${path} ${status}`,
    request_id: requestId,
    method: 'GET',
    path,
    status,
    latency_ms: Math.round(performance.now() - started),
    user_id: userId,
    input_summary: { format: 'csv' },
    output_summary: { subscribers: rows },
    err_code: errCode,
  });
  return response;
}
