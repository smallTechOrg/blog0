// Listen tab + image button → the audio and image routes (spec/api.md). The admin UI never calls
// PUT …/listen (aligner-facing). JSON calls go through the shared apiRequest; uploads use XHR so
// `upload.onprogress` can drive the progress bar and `abort()` the Cancel button. Same envelope
// handling as apiRequest.

import type { Envelope } from '@/lib/api/envelope';
import type { GetListenResponse, ImageUploadResponse, ListenResponse } from '@/lib/api/dto';

import { apiRequest, articleApi, NETWORK_MESSAGE, toApiResult, type ApiResult } from '../api';

export interface UploadProgress {
  loaded: number;
  total: number;
}

export interface UploadOptions {
  onProgress?: (p: UploadProgress) => void;
  signal?: AbortSignal;
}

function parseEnvelope<T>(status: number, text: string): ApiResult<T> {
  let envelope: Envelope<T> | null = null;
  try {
    envelope = JSON.parse(text) as Envelope<T>;
  } catch {
    envelope = null;
  }
  if (!envelope && status === 413) return { ok: false, status, error: { code: 'PAYLOAD_TOO_LARGE', message: 'That file is too large.' } };
  return toApiResult(status, envelope);
}

/** Multipart POST with progress + cancel. Resolves (never rejects) with the unwrapped envelope. */
export function uploadMultipart<T>(url: string, form: FormData, opts: UploadOptions = {}): Promise<ApiResult<T>> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.setRequestHeader('accept', 'application/json');
    xhr.withCredentials = false; // same-origin: cookies go anyway, like fetch's 'same-origin'

    const onAbort = () => xhr.abort();
    if (opts.signal) {
      if (opts.signal.aborted) {
        resolve({ ok: false, status: 0, error: { code: 'ABORTED', message: 'Upload cancelled.' } });
        return;
      }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    const done = (r: ApiResult<T>) => {
      opts.signal?.removeEventListener('abort', onAbort);
      resolve(r);
    };

    xhr.upload.onprogress = (e) => {
      if (opts.onProgress) opts.onProgress({ loaded: e.loaded, total: e.lengthComputable ? e.total : 0 });
    };
    xhr.onload = () => done(parseEnvelope<T>(xhr.status, xhr.responseText));
    xhr.onerror = () => done({ ok: false, status: 0, error: { code: 'NETWORK', message: NETWORK_MESSAGE } });
    xhr.onabort = () => done({ ok: false, status: 0, error: { code: 'ABORTED', message: 'Upload cancelled.' } });
    xhr.ontimeout = () => done({ ok: false, status: 0, error: { code: 'NETWORK', message: NETWORK_MESSAGE } });
    xhr.send(form);
  });
}


export function getListen(articleId: string): Promise<ApiResult<GetListenResponse>> {
  return apiRequest<GetListenResponse>(articleApi(articleId, 'listen'));
}

export function deleteAudio(articleId: string): Promise<ApiResult<ListenResponse>> {
  return apiRequest<ListenResponse>(articleApi(articleId, 'audio'), { method: 'DELETE' });
}

export function uploadAudio(articleId: string, file: File, opts: UploadOptions = {}): Promise<ApiResult<ListenResponse>> {
  const form = new FormData();
  form.append('file', file, file.name);
  return uploadMultipart<ListenResponse>(articleApi(articleId, 'audio'), form, opts);
}

export interface ImageUploadFields {
  alt: string;
  caption?: string;
  articleId?: string;
}

export function uploadImage(file: File, fields: ImageUploadFields, opts: UploadOptions = {}): Promise<ApiResult<ImageUploadResponse>> {
  const form = new FormData();
  form.append('file', file, file.name);
  form.append('alt', fields.alt);
  if (fields.caption && fields.caption.trim() !== '') form.append('caption', fields.caption.trim());
  if (fields.articleId) form.append('articleId', fields.articleId);
  return uploadMultipart<ImageUploadResponse>('/api/admin/uploads/images', form, opts);
}

/** "12 MB of 31 MB" style sizes. */
export function fmtMb(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}
