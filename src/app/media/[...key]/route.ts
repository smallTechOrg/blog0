import { errEnvelope } from '@/lib/api/envelope';
import { requestIdFor, respond } from '@/server/http/api';
import { asciiFilename, etagMatches, parseRange } from '@/server/media/range';
import { findMediaAssetByKey } from '@/server/media/repo';
import { log } from '@/server/log';
import { getCurrentSite } from '@/server/site/current';
import { getStorage } from '@/server/storage';
import { isValidStorageKey, StorageError, type ByteRange } from '@/server/storage/types';

// GET / HEAD /media/[...key] (spec/architecture.md §9.2, §6; spec/api.md). Not withApi
// (the body is bytes, not JSON): still sets x-request-id and writes one `media.request` line.
// 200 full / 206 one range / 304 / 416 / 404 JSON envelope; other methods 405 with Allow.

export const dynamic = 'force-dynamic';

interface Ctx {
  params: Promise<{ key?: string | string[] }>;
}

const CACHE_CONTROL = 'public, max-age=31536000, immutable';

function notFound(requestId: string): Response {
  return respond(errEnvelope('NOT_FOUND', 'No such media.', requestId), 404, requestId);
}

async function serve(request: Request, ctx: Ctx, head: boolean): Promise<Response> {
  const started = performance.now();
  const requestId = requestIdFor(request);
  let key = '';
  let status = 404;
  let rangeHeader: string | undefined;
  let bytesSent = 0;

  try {
    const raw = (await ctx.params).key;
    key = Array.isArray(raw) ? raw.join('/') : (raw ?? '');
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
    return respond(errEnvelope('INTERNAL', 'Something went wrong serving this file.', requestId), status, requestId);
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

export const GET = (request: Request, ctx: Ctx): Promise<Response> => serve(request, ctx, false);
export const HEAD = (request: Request, ctx: Ctx): Promise<Response> => serve(request, ctx, true);

async function methodNotAllowed(request: Request): Promise<Response> {
  return new Response(null, { status: 405, headers: { allow: 'GET, HEAD', 'x-request-id': requestIdFor(request) } });
}

export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const OPTIONS = methodNotAllowed;
