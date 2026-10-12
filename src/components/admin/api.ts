// Admin client → JSON route handlers (spec/api.md). Pure fetch wrapper: unwraps the envelope,
// maps network/abort/garbled responses to readable errors. Browsers send the `Origin` header on
// same-origin POST/PATCH/PUT/DELETE, which the CSRF check requires.

import type { Envelope } from '@/lib/api/envelope';

export interface ApiFailure {
  code: string;
  message: string;
  details?: unknown;
}

export type ApiResult<T> = { ok: true; status: number; data: T } | { ok: false; status: number; error: ApiFailure };

export interface ApiRequestInit {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

export const NETWORK_MESSAGE = "Couldn't reach the server — check your connection and try again.";
export const UNEXPECTED_MESSAGE = 'Something went wrong on our side. Try again in a moment.';

function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

const ABORTED: ApiFailure = { code: 'ABORTED', message: 'Request was cancelled.' };

/** Unwraps a parsed envelope (null when the body was not JSON); INTERNAL errors read as UNEXPECTED_MESSAGE. */
export function toApiResult<T>(status: number, envelope: Envelope<T> | null): ApiResult<T> {
  if (envelope && envelope.ok === true) return { ok: true, status, data: envelope.data };
  if (envelope && envelope.ok === false && envelope.error) {
    const { code, message, details } = envelope.error;
    const error: ApiFailure = { code, message: code === 'INTERNAL' ? UNEXPECTED_MESSAGE : message };
    if (details !== undefined) error.details = details;
    return { ok: false, status, error };
  }
  return { ok: false, status, error: { code: 'INTERNAL', message: UNEXPECTED_MESSAGE } };
}

export async function apiRequest<T>(path: string, init: ApiRequestInit = {}): Promise<ApiResult<T>> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (init.body !== undefined) headers['content-type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: 'same-origin',
      cache: 'no-store',
      signal: init.signal,
    });
  } catch (error) {
    if (isAbort(error)) return { ok: false, status: 0, error: ABORTED };
    return { ok: false, status: 0, error: { code: 'NETWORK', message: NETWORK_MESSAGE } };
  }

  let envelope: Envelope<T> | null = null;
  try {
    envelope = (await response.json()) as Envelope<T>;
  } catch (error) {
    if (isAbort(error)) return { ok: false, status: response.status, error: ABORTED };
  }
  return toApiResult(response.status, envelope);
}

/** `/api/admin/articles/<id>[/<sub>]` — an article's admin route (spec/api.md). */
export function articleApi(articleId: string, sub?: string): string {
  return '/api/admin/articles/' + encodeURIComponent(articleId) + (sub ? '/' + sub : '');
}

/** Sign-in URL that returns here afterwards. */
export function signInHref(path: string): string {
  return '/admin/login?next=' + encodeURIComponent(path);
}
