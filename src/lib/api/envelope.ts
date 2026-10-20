// The JSON envelope used at every API boundary (spec/api.md, spec/architecture.md §8). Pure + isomorphic.

export type Ok<T> = { ok: true; data: T };
export type Err = { ok: false; error: { code: string; message: string; details?: unknown; requestId: string } };
export type Envelope<T> = Ok<T> | Err;

export function okEnvelope<T>(data: T): Ok<T> {
  return { ok: true, data };
}

export function errEnvelope(code: string, message: string, requestId: string, details?: unknown): Err {
  const error: Err['error'] = { code, message, requestId };
  if (details !== undefined) error.details = details;
  return { ok: false, error };
}
