import 'server-only';

import { ApiError, payloadTooLarge, precheckContentLength } from '../http/api';
import { log } from '../log';
import { getStorage } from '../storage';
import { makeStorageKey, StorageError, type StoredKind, type StoredMime } from '../storage/types';
import { insertMediaAsset, type Executor } from './repo';
import type { MediaAssetRow } from '../db/schema';

// Upload ingest (spec/architecture.md §9.3), shared by images (S3.1) and audio (S3.2):
//   ingestUpload(form, { field, maxBytes })  → the multipart File as a Buffer (+ cleaned filename)
//   storeMediaAsset({...})                    → put() then the media_asset row; a DB failure after
//                                              put deletes the file (try/finally).
// Uploads are ≤ 50 MB and writers are few, so buffering in memory is acceptable in v0.1.

export interface UploadFile {
  buffer: Buffer;
  /** Basename only, control characters stripped, ≤ 255 chars; 'upload' when empty. */
  originalFilename: string;
  /** The browser's declared type — informational only; content detection decides. */
  declaredType: string;
}

export interface IngestOptions {
  field?: string;
  maxBytes: number;
  /** When given, the declared Content-Length is checked before the form is read. */
  request?: Request;
}

const MAX_FILENAME = 255;

/** Basename only (either separator), control chars stripped, trimmed, ≤ 255 chars. */
export function cleanOriginalFilename(name: string | null | undefined): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const limited = Array.from(cleaned).slice(0, MAX_FILENAME).join('');
  return limited === '' || limited === '.' || limited === '..' ? 'upload' : limited;
}

export async function ingestUpload(form: FormData, opts: IngestOptions): Promise<UploadFile> {
  const field = opts.field ?? 'file';
  if (opts.request) precheckContentLength(opts.request, opts.maxBytes);
  const value = form.get(field);
  if (!(value instanceof File)) {
    throw new ApiError('VALIDATION_FAILED', 400, `Attach the file as the "${field}" field.`, { fieldErrors: { [field]: ['A file is required'] } });
  }
  if (value.size > opts.maxBytes) throw payloadTooLarge(opts.maxBytes);
  const buffer = Buffer.from(await value.arrayBuffer());
  if (buffer.length > opts.maxBytes) throw payloadTooLarge(opts.maxBytes);
  if (buffer.length === 0) {
    throw new ApiError('VALIDATION_FAILED', 400, 'That file is empty.', { fieldErrors: { [field]: ['The file is empty'] } });
  }
  return { buffer, originalFilename: cleanOriginalFilename(value.name), declaredType: value.type };
}

export interface StoreMediaAssetInput {
  siteId: string;
  siteSlug: string;
  kind: StoredKind;
  mime: StoredMime;
  buffer: Buffer;
  maxBytes: number;
  originalFilename: string;
  createdBy: string;
  articleId?: string | null;
  durationMs?: number | null;
  width?: number | null;
  height?: number | null;
  now?: Date;
  db?: Executor;
}

/** put() → media_asset row. Any failure after the file is written removes it again. */
export async function storeMediaAsset(input: StoreMediaAssetInput): Promise<MediaAssetRow> {
  const storage = getStorage();
  const key = makeStorageKey(input.siteSlug, input.kind, input.mime, input.now ?? new Date());
  let stored;
  try {
    stored = await storage.put(key, input.buffer, { maxBytes: input.maxBytes });
  } catch (error) {
    if (error instanceof StorageError && error.code === 'TOO_LARGE') throw payloadTooLarge(input.maxBytes);
    throw error;
  }
  let committed = false;
  try {
    const row = await insertMediaAsset(
      {
        siteId: input.siteId,
        kind: input.kind,
        storageKey: key,
        originalFilename: input.originalFilename,
        mimeType: input.mime,
        byteSize: stored.size,
        sha256: stored.sha256,
        durationMs: input.durationMs ?? null,
        width: input.width ?? null,
        height: input.height ?? null,
        articleId: input.articleId ?? null,
        createdBy: input.createdBy,
      },
      input.db,
    );
    committed = true;
    return row;
  } finally {
    if (!committed) {
      await storage.delete(key).catch((error: unknown) => {
        log.warn('media.cleanup', { msg: 'Could not remove the file after a failed media_asset insert', key, err_message: (error as Error).message });
      });
    }
  }
}

/** Shared `media.upload` log line (spec/architecture.md §7). */
export function logMediaUpload(fields: {
  requestId: string;
  kind: StoredKind;
  outcome: 'ok' | 'rejected';
  mime?: string | null;
  bytes?: number;
  durationMs?: number | null;
  width?: number | null;
  height?: number | null;
  articleId?: string | null;
  errCode?: string;
}): void {
  log.info('media.upload', {
    msg: `media.upload ${fields.kind} ${fields.outcome}${fields.errCode ? ` ${fields.errCode}` : ''}`,
    request_id: fields.requestId,
    kind: fields.kind,
    mime: fields.mime ?? undefined,
    bytes: fields.bytes,
    duration_ms: fields.durationMs ?? undefined,
    width: fields.width ?? undefined,
    height: fields.height ?? undefined,
    article_id: fields.articleId ?? undefined,
    outcome: fields.outcome,
    err_code: fields.errCode,
  });
}
