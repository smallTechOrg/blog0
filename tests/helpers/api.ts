// Route-handler calls for integration tests: call() builds a same-origin Request (session cookie,
// Origin on mutations, JSON or multipart body, `[id]` param) and returns the parsed envelope;
// data()/err() unwrap it; createArticle()/publish() are the two admin calls most files need.
import { POST as publishRoute } from '@/app/api/admin/articles/[id]/publish/route';
import { POST as createRoute } from '@/app/api/admin/articles/route';
import type { ArticleDetailDto, ArticleResponse } from '@/lib/api/dto';
import type { Envelope, Err } from '@/lib/api/envelope';

import type { TestLogin } from './session';

export const ORIGIN = 'http://localhost:3410';

export type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

let defaultLogin: TestLogin | null = null;

/** The login call() uses when a call passes neither `who` nor `cookie` (set it in beforeEach). */
export function actAs(login: TestLogin): TestLogin {
  defaultLogin = login;
  return login;
}

export interface CallOptions {
  /** JSON body. */
  body?: unknown;
  /** Multipart body (uploads). */
  form?: FormData;
  /** The `[id]` route param. */
  id?: string;
  /** Sign in as this user instead of the actAs() one. */
  who?: TestLogin;
  /** An explicit Cookie header; null sends none. */
  cookie?: string | null;
  /** Origin for mutations (default: the site's own); null sends none. */
  origin?: string | null;
  headers?: Record<string, string>;
}

export async function call<T>(handler: Handler, method: string, url: string, opts: CallOptions = {}) {
  const headers: Record<string, string> = { host: 'localhost:3410', ...opts.headers };
  const cookie = opts.cookie !== undefined ? opts.cookie : (opts.who ?? defaultLogin)?.cookie;
  if (cookie) headers.cookie = cookie;
  if (opts.origin !== null && method !== 'GET') headers.origin = opts.origin ?? ORIGIN;
  let body: BodyInit | undefined = opts.form;
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await handler(new Request(`${ORIGIN}${url}`, { method, headers, body }), {
    params: Promise.resolve<Record<string, string>>(opts.id ? { id: opts.id } : {}),
  });
  return { status: res.status, env: (await res.json()) as Envelope<T>, res };
}

export function data<T>(env: Envelope<T>): T {
  if (!env.ok) throw new Error(`expected ok envelope, got ${env.error.code}: ${env.error.message}`);
  return env.data;
}

export function err(env: Envelope<unknown>): Err['error'] {
  if (env.ok) throw new Error('expected an error envelope');
  return env.error;
}

/** POST /api/admin/articles → the created article (throws on a non-ok envelope). */
export async function createArticle(body: Record<string, unknown>, who?: TestLogin): Promise<ArticleDetailDto> {
  return data((await call<ArticleResponse>(createRoute, 'POST', '/api/admin/articles', { body, who })).env).article;
}

/** POST /api/admin/articles/:id/publish (the raw call result: publish may be refused). */
export function publish(id: string, revisionId: string, who?: TestLogin) {
  return call<ArticleResponse>(publishRoute, 'POST', `/api/admin/articles/${id}/publish`, { body: { revisionId }, id, who });
}
