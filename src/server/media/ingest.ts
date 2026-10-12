import 'server-only';

import { ApiError } from '../http/api';
import { log, type LogFields } from '../log';
import { getStorage } from '../storage';
import { makeStorageKey, StorageError, type StoredKind, type StoredMime, type StoredObject } from '../storage/types';

// Upload ingest pipeline (spec/architecture.md §9.3), shared by images and audio:
//   formFile(form, message)        → the multipart `file` part (400 when absent)
//   readUpload(file, rules)        → its bytes; the byte limit is enforced before and after reading
//   storeUpload(input, commit)     → put() under a fresh key, then `commit` (the DB work); a
//                                    failure in `commit` removes the file again
//   logUploadRejections(kind, ctx) → one `media.upload … rejected` line per refused upload
// Uploads are ≤ 50 MB and writers are few, so buffering in memory is acceptable in v0.1.

const MAX_FILENAME = 255;
/** Statuses that count as a rejected upload in the `media.upload` log (spec/architecture.md §7). */
const REJECTED_STATUSES = new Set([400, 413, 415, 422]);

/** Basename only (either separator), control chars stripped, trimmed, ≤ 255 chars; `fallback` when empty. */
export function cleanOriginalFilename(name: string | null | undefined, fallback = 'upload'): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = Array.from(base.replace(/[\u0000-\u001f\u007f]/g, '').trim()).slice(0, MAX_FILENAME).join('');
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? fallback : cleaned;
}

/** The multipart `file` part, or 400 VALIDATION_FAILED with `message`. */
export function formFile(form: FormData, message: string): File {
  const value = form.get('file');
  if (!(value instanceof File)) throw new ApiError('VALIDATION_FAILED', 400, message, { fieldErrors: { file: ['A file is required'] } });
  return value;
}

export interface UploadRules {
  maxBytes: number;
  tooLarge: () => ApiError;
  empty: () => ApiError;
}

/** Reads the upload into memory; over `maxBytes` (declared or actual) → `tooLarge`, 0 bytes → `empty`. */
export async function readUpload(file: File, rules: UploadRules): Promise<Buffer> {
  if (file.size > rules.maxBytes) throw rules.tooLarge();
  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.length > rules.maxBytes) throw rules.tooLarge();
  if (buffer.length === 0) throw rules.empty();
  return buffer;
}

export interface StoreUploadInput {
  siteSlug: string;
  kind: StoredKind;
  mime: StoredMime;
  buffer: Buffer;
  rules: UploadRules;
  now?: Date;
  requestId?: string;
}

/** put() under a fresh key, then `commit(stored)`. Any failure in `commit` removes the file again. */
export async function storeUpload<T>(input: StoreUploadInput, commit: (stored: StoredObject) => Promise<T>): Promise<T> {
  const storage = getStorage();
  const key = makeStorageKey(input.siteSlug, input.kind, input.mime, input.now ?? new Date());
  let stored: StoredObject;
  try {
    stored = await storage.put(key, input.buffer, { maxBytes: input.rules.maxBytes });
  } catch (error) {
    if (error instanceof StorageError && error.code === 'TOO_LARGE') throw input.rules.tooLarge();
    log.error('media.upload', { msg: 'storage put failed', request_id: input.requestId, key, err_message: (error as Error).message });
    throw new ApiError('INTERNAL', 500, "Couldn't store the file — try again; if it keeps happening, check the server log.");
  }
  try {
    return await commit(stored);
  } catch (error) {
    await storage.delete(key).catch((e: unknown) => {
      log.warn('media.cleanup', { msg: 'Could not remove the file after a failed upload commit', key, err_message: (e as Error).message });
    });
    throw error;
  }
}

/** The shared `media.upload` log line (spec/architecture.md §7); `fields` are snake_case log fields. */
export function logMediaUpload(kind: StoredKind, outcome: 'ok' | 'rejected', fields: LogFields): void {
  const code = typeof fields.err_code === 'string' ? ` ${fields.err_code}` : '';
  log.info('media.upload', { msg: `media.upload ${kind} ${outcome}${code}`, kind, outcome, ...fields });
}

/** Runs an upload; a refusal (400/413/415/422) logs one rejected line with `context` as it stands then. */
export async function logUploadRejections<T>(kind: StoredKind, context: LogFields, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiError && REJECTED_STATUSES.has(error.status)) {
      logMediaUpload(kind, 'rejected', { ...context, err_code: error.code });
    }
    throw error;
  }
}
