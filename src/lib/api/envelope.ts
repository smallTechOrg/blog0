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

export function isOk<T>(envelope: Envelope<T>): envelope is Ok<T> {
  return envelope.ok === true;
}

/** Error codes from spec/api.md → "Error codes". */
export const API_ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'BAD_CREDENTIALS',
  'FORBIDDEN_ORIGIN',
  'NOT_FOUND',
  'CONFLICT',
  'SLUG_TAKEN',
  'SLUG_LOCKED',
  'GENERATION_IN_PROGRESS',
  'NOT_DELETABLE',
  'PUBLISH_BLOCKED',
  'DECK_INVALID',
  'JEV_NO_SENTENCES',
  'JEV_INPUT_TOO_LONG',
  'LLM_AUTH',
  'LLM_INSUFFICIENT_CREDITS',
  'LLM_MODEL_NOT_FOUND',
  'LLM_RATE_LIMITED',
  'LLM_UNAVAILABLE',
  'LLM_TIMEOUT',
  'LLM_INVALID_OUTPUT',
  'RATE_LIMITED',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA',
  'DB_UNAVAILABLE',
  'INTERNAL',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];
