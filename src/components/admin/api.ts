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
    if (isAbort(error)) return { ok: false, status: 0, error: { code: 'ABORTED', message: 'Request was cancelled.' } };
    return { ok: false, status: 0, error: { code: 'NETWORK', message: NETWORK_MESSAGE } };
  }

  let envelope: Envelope<T> | null = null;
  try {
    envelope = (await response.json()) as Envelope<T>;
  } catch (error) {
    if (isAbort(error)) return { ok: false, status: response.status, error: { code: 'ABORTED', message: 'Request was cancelled.' } };
    envelope = null;
  }

  if (envelope && envelope.ok === true) return { ok: true, status: response.status, data: envelope.data };
  if (envelope && envelope.ok === false && envelope.error) {
    const { code, message, details } = envelope.error;
    const error: ApiFailure = { code, message: code === 'INTERNAL' ? UNEXPECTED_MESSAGE : message };
    if (details !== undefined) error.details = details;
    return { ok: false, status: response.status, error };
  }
  return { ok: false, status: response.status, error: { code: 'INTERNAL', message: UNEXPECTED_MESSAGE } };
}

/** Sign-in URL that returns here afterwards. */
export function signInHref(path: string): string {
  return '/admin/login?next=' + encodeURIComponent(path);
}
