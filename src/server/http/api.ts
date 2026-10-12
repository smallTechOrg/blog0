import 'server-only';

import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { errEnvelope, okEnvelope } from '@/lib/api/envelope';

import { getConfig } from '../config';
import { log } from '../log';
import type { AdminAuth } from '../auth/guard';

// HTTP kit (spec/architecture.md §2, §7, §8): withApi() wraps every route handler with a request id,
// auth guard, same-origin check on mutations, zod body parsing, the JSON envelope, error mapping and
// one `api.request` log line per request.

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;
  readonly headers?: Record<string, string>;

  constructor(code: string, status: number, message: string, details?: unknown, headers?: Record<string, string>) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.headers = headers;
  }
}

/** Return from a handler to control the status code / extra headers (e.g. 201, Set-Cookie). */
export class ApiResult<T> {
  constructor(
    readonly data: T,
    readonly init: { status?: number; headers?: Array<[string, string]> } = {},
  ) {}
}

export function apiResult<T>(data: T, init: { status?: number; headers?: Array<[string, string]> } = {}): ApiResult<T> {
  return new ApiResult(data, init);
}

type Params = Record<string, string | string[] | undefined>;
/** Next.js route-handler context (params is a Promise in Next 15+). */
export interface RouteContext {
  params: Promise<Params>;
}

type AuthMode = 'admin' | 'none';
type Summary = Record<string, unknown>;

export interface ApiOptions<S extends z.ZodType | undefined, A extends AuthMode> {
  auth: A;
  /** Same-origin check; defaults to true for POST/PUT/PATCH/DELETE. */
  csrf?: boolean;
  body?: S;
  /** Counts/ids only — never article text, passwords, tokens, keys or full emails. */
  summarizeInput?: (body: S extends z.ZodType ? z.infer<S> : undefined) => Summary;
  summarizeOutput?: (data: unknown) => Summary;
}

export interface ApiContext<S extends z.ZodType | undefined, A extends AuthMode> {
  request: Request;
  requestId: string;
  params: Params;
  body: S extends z.ZodType ? z.infer<S> : undefined;
  auth: A extends 'admin' ? AdminAuth : null;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,80}$/;
const INTERNAL_MESSAGE = 'Something went wrong on our side. Try again; if it keeps happening, check the server log.';

function requestIdFor(request: Request): string {
  const incoming = request.headers.get('x-request-id');
  return incoming && REQUEST_ID_RE.test(incoming) ? incoming : randomUUID();
}

function originAllowed(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin || origin === 'null') return false;
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }
  const publicOrigin = new URL(getConfig().publicBaseUrl).origin;
  if (originUrl.origin === publicOrigin) return true;
  const host = request.headers.get('host');
  return host !== null && originUrl.host === host;
}

function json(body: unknown, status: number, requestId: string, extra: Array<[string, string]> = []): Response {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-request-id': requestId,
  });
  for (const [name, value] of extra) headers.append(name, value);
  return new Response(JSON.stringify(body), { status, headers });
}

async function parseBody(request: Request, schema: z.ZodType): Promise<unknown> {
  let raw: unknown;
  try {
    const text = await request.text();
    raw = text.trim() === '' ? {} : JSON.parse(text);
  } catch {
    throw new ApiError('VALIDATION_FAILED', 400, 'The request body is not valid JSON.');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError('VALIDATION_FAILED', 400, 'Some fields are missing or invalid.', z.flattenError(parsed.error));
  }
  return parsed.data;
}

export function withApi<S extends z.ZodType | undefined = undefined, A extends AuthMode = AuthMode>(
  options: ApiOptions<S, A>,
  handler: (ctx: ApiContext<S, A>) => Promise<unknown>,
): (request: Request, context: RouteContext) => Promise<Response> {
  return async function apiRoute(request: Request, context: RouteContext): Promise<Response> {
    const started = performance.now();
    const requestId = requestIdFor(request);
    const method = request.method.toUpperCase();
    let path = '';
    try {
      path = new URL(request.url).pathname;
    } catch {
      path = request.url;
    }

    let status = 200;
    let userId: string | undefined;
    let inputSummary: Summary = {};
    let outputSummary: Summary = {};
    let errCode: string | undefined;
    let response: Response;

    try {
      const csrf = options.csrf ?? MUTATING.has(method);
      if (csrf && !originAllowed(request)) {
        throw new ApiError('FORBIDDEN_ORIGIN', 403, 'This request must come from the blog0 site itself.');
      }

      let auth: AdminAuth | null = null;
      if (options.auth === 'admin') {
        const { requireAdmin } = await import('../auth/guard');
        auth = await requireAdmin(request);
        userId = auth.user.id;
      }

      const params = context?.params ? await context.params : {};
      const body = options.body ? await parseBody(request, options.body) : undefined;
      if (options.summarizeInput) {
        inputSummary = options.summarizeInput(body as S extends z.ZodType ? z.infer<S> : undefined);
      }

      const result = await handler({
        request,
        requestId,
        params,
        body: body as ApiContext<S, A>['body'],
        auth: auth as ApiContext<S, A>['auth'],
      });

      const extraHeaders: Array<[string, string]> = [];
      if (auth?.setCookie) extraHeaders.push(['set-cookie', auth.setCookie]);
      let data: unknown = result;
      if (result instanceof ApiResult) {
        data = result.data;
        status = result.init.status ?? 200;
        extraHeaders.push(...(result.init.headers ?? []));
      }
      if (options.summarizeOutput) outputSummary = options.summarizeOutput(data);
      response = json(okEnvelope(data), status, requestId, extraHeaders);
    } catch (error) {
      if (error instanceof ApiError) {
        status = error.status;
        errCode = error.code;
        response = json(
          errEnvelope(error.code, error.message, requestId, error.details),
          error.status,
          requestId,
          Object.entries(error.headers ?? {}),
        );
      } else {
        status = 500;
        errCode = 'INTERNAL';
        const err = error instanceof Error ? error : new Error(String(error));
        log.error('error', {
          msg: 'Unhandled error in API route',
          request_id: requestId,
          method,
          path,
          err_message: err.message,
          err_stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
        });
        response = json(errEnvelope('INTERNAL', INTERNAL_MESSAGE, requestId), 500, requestId);
      }
    }

    log.info('api.request', {
      msg: `${method} ${path} ${status}`,
      request_id: requestId,
      method,
      path,
      status,
      latency_ms: Math.round(performance.now() - started),
      user_id: userId,
      input_summary: inputSummary,
      output_summary: outputSummary,
      err_code: errCode,
    });
    return response;
  };
}
