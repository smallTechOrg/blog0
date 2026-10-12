import { randomUUID } from 'node:crypto';

import { errEnvelope } from '@/lib/api/envelope';
import { parseRange } from '@/server/media/range';
import { findMediaAssetByKey } from '@/server/media/repo';
import { log } from '@/server/log';
import { getCurrentSite } from '@/server/site/current';
import { getStorage } from '@/server/storage';
import { isValidStorageKey, StorageError, type ByteRange } from '@/server/storage/types';

// GET / HEAD /media/[...key] (spec/architecture.md §9.2, §6; spec/api.md Phase 3). Not withApi
// (the body is bytes, not JSON): still sets x-request-id and writes one `media.request` line.
// 200 full / 206 one range / 304 / 416 / 404 JSON envelope; other methods 405 with Allow.

export const dynamic = 'force-dynamic';

interface Ctx {
  params: Promise<{ key?: string | string[] }>;
}

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,80}$/;
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

function requestIdFor(request: Request): string {
  const incoming = request.headers.get('x-request-id');
  return incoming && REQUEST_ID_RE.test(incoming) ? incoming : randomUUID();
}

function notFound(requestId: string): Response {
  return new Response(JSON.stringify(errEnvelope('NOT_FOUND', 'No such media.', requestId)), {
    status: 404,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-request-id': requestId },
  });
}

/** `If-None-Match`: any listed tag equal to the ETag (`W/` prefix tolerated), or `*`. */
export function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  const bare = etag.replace(/^W\//, '');
  for (const part of header.split(',')) {
    const tag = part.trim();
    if (tag === '*') return true;
    if (tag.replace(/^W\//, '') === bare) return true;
  }
  return false;
}

/** ASCII-safe filename for Content-Disposition (quotes, backslashes, non-ASCII → `_`). */
export function asciiFilename(name: string): string {
  const safe = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_').trim();
  return safe === '' ? 'file' : safe;
}

function keyOf(raw: string | string[] | undefined): string {
  if (Array.isArray(raw)) return raw.join('/');
  return raw ?? '';
}

async function serve(request: Request, ctx: Ctx, head: boolean): Promise<Response> {
  const started = performance.now();
  const requestId = requestIdFor(request);
  let key = '';
  let status = 404;
  let rangeHeader: string | undefined;
  let bytesSent = 0;

  try {
    key = keyOf((await ctx.params).key);
    if (!isValidStorageKey(key)) return notFound(requestId);

    const site = await getCurrentSite();
    const row = await findMediaAssetByKey(site.id, key);
    if (!row) return notFound(requestId);

    const storage = getStorage();
    const stat = await storage.stat(key);
    if (!stat) {
      log.warn('media.request', { msg: `media_asset ${row.id} has no file on disk`, request_id: requestId, key, status: 404 });
      return notFound(requestId);
    }

    const etag = `"${row.sha256}"`;
    const headers = new Headers({
      'content-type': row.mimeType,
      'accept-ranges': 'bytes',
      etag,
      'last-modified': row.createdAt.toUTCString(),
      'cache-control': CACHE_CONTROL,
      'x-content-type-options': 'nosniff',
      'content-disposition': `inline; filename="${asciiFilename(row.originalFilename)}"`,
      'x-request-id': requestId,
    });

    if (etagMatches(request.headers.get('if-none-match'), etag)) {
      status = 304;
      headers.delete('content-type');
      headers.delete('content-disposition');
      return new Response(null, { status, headers });
    }

    const size = stat.size;
    let range: ByteRange | null = null;
    const rangeValue = request.headers.get('range');
    const ifRange = request.headers.get('if-range');
    if (rangeValue && (ifRange === null || etagMatches(ifRange, etag))) {
      rangeHeader = rangeValue;
      const parsed = parseRange(rangeValue, size);
      if (parsed === 'unsatisfiable') {
        status = 416;
        headers.set('content-range', `bytes */${size}`);
        headers.set('content-length', '0');
        return new Response(null, { status, headers });
      }
      range = parsed;
    }

    if (range) {
      status = 206;
      headers.set('content-range', `bytes ${range.start}-${range.end}/${size}`);
      headers.set('content-length', String(range.end - range.start + 1));
      bytesSent = range.end - range.start + 1;
    } else {
      status = 200;
      headers.set('content-length', String(size));
      bytesSent = size;
    }

    if (head) {
      bytesSent = 0;
      return new Response(null, { status, headers });
    }
    if (bytesSent === 0) return new Response(null, { status, headers });
    const { stream } = await storage.stream(key, range ?? undefined);
    return new Response(stream, { status, headers });
  } catch (error) {
    if (error instanceof StorageError && (error.code === 'NOT_FOUND' || error.code === 'BAD_KEY' || error.code === 'BAD_RANGE')) {
      status = 404;
      return notFound(requestId);
    }
    status = 500;
    const err = error instanceof Error ? error : new Error(String(error));
    log.error('error', {
      msg: 'Unhandled error in /media route',
      request_id: requestId,
      path: `/media/${key}`,
      err_message: err.message,
      err_stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
    });
    return new Response(JSON.stringify(errEnvelope('INTERNAL', 'Something went wrong serving this file.', requestId)), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-request-id': requestId },
    });
  } finally {
    log.info('media.request', {
      msg: `${head ? 'HEAD' : 'GET'} /media/${key} ${status}`,
      request_id: requestId,
      key,
      status,
      range: rangeHeader,
      bytes_sent: bytesSent,
      latency_ms: Math.round(performance.now() - started),
    });
  }
}

export async function GET(request: Request, ctx: Ctx): Promise<Response> {
  return serve(request, ctx, false);
}

export async function HEAD(request: Request, ctx: Ctx): Promise<Response> {
  return serve(request, ctx, true);
}

function methodNotAllowed(request: Request): Response {
  return new Response(null, { status: 405, headers: { allow: 'GET, HEAD', 'x-request-id': requestIdFor(request) } });
}

export async function POST(request: Request): Promise<Response> {
  return methodNotAllowed(request);
}
export async function PUT(request: Request): Promise<Response> {
  return methodNotAllowed(request);
}
export async function PATCH(request: Request): Promise<Response> {
  return methodNotAllowed(request);
}
export async function DELETE(request: Request): Promise<Response> {
  return methodNotAllowed(request);
}
export async function OPTIONS(request: Request): Promise<Response> {
  return methodNotAllowed(request);
}
