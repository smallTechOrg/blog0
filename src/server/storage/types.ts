import { randomUUID } from 'node:crypto';

// Storage interface (spec/architecture.md §9.1) — the contract every Phase 3 slice codes against.
// Pure types + key helpers; no filesystem access here (LocalDiskStorage lives in local-disk.ts).

export interface StoredObject {
  key: string;
  size: number;
  sha256: string;
}

/** Inclusive, 0-based: start ≤ end < size. */
export interface ByteRange {
  start: number;
  end: number;
}

export interface StorageStat {
  size: number;
  mtime: Date;
}

export interface StorageStream {
  stream: ReadableStream<Uint8Array>;
  /** Total object size (not the range length). */
  size: number;
  range: ByteRange | null;
}

export type StorageErrorCode = 'NOT_FOUND' | 'TOO_LARGE' | 'BAD_KEY' | 'BAD_RANGE' | 'IO';

export class StorageError extends Error {
  readonly code: StorageErrorCode;

  constructor(code: StorageErrorCode, message: string) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
  }
}

export interface Storage {
  /** Write atomically: temp file in the same dir → fsync → rename. Over `maxBytes` → StorageError
   *  TOO_LARGE and nothing left on disk. Returns size + sha256 computed while writing. */
  put(key: string, body: Buffer | ReadableStream<Uint8Array>, opts: { maxBytes: number }): Promise<StoredObject>;
  /** Whole object (probes, tests). null when missing. */
  get(key: string): Promise<Buffer | null>;
  stat(key: string): Promise<StorageStat | null>;
  /** Idempotent: deleting a missing key resolves. */
  delete(key: string): Promise<void>;
  /** Byte stream of the whole object or one range. NOT_FOUND / BAD_RANGE as StorageError. */
  stream(key: string, range?: ByteRange): Promise<StorageStream>;
}

export const STORAGE_EXTENSIONS = {
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
} as const;

export type StoredMime = keyof typeof STORAGE_EXTENSIONS;
export type StoredKind = 'audio' | 'image';

export const STORED_MIMES = Object.keys(STORAGE_EXTENSIONS) as StoredMime[];

export function isStoredMime(value: unknown): value is StoredMime {
  return typeof value === 'string' && Object.hasOwn(STORAGE_EXTENSIONS, value);
}

/** `<siteSlug>/<audio|image>/<yyyy>/<mm>/<uuid v4>.<ext>` — the only accepted shape. */
export const STORAGE_KEY_RE =
  /^[a-z0-9]+(?:-[a-z0-9]+)*\/(?:audio|image)\/\d{4}\/\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:mp3|m4a|png|jpg|webp|gif)$/;

export const STORAGE_KEY_MAX_LENGTH = 160;

/** STORAGE_KEY_RE.test(key) && key.length <= 160 — no '..', leading '/', '%', '\0' or newline survive the regex. */
export function isValidStorageKey(key: string): boolean {
  return typeof key === 'string' && key.length <= STORAGE_KEY_MAX_LENGTH && STORAGE_KEY_RE.test(key);
}

export function makeStorageKey(siteSlug: string, kind: StoredKind, mime: StoredMime, now: Date): string {
  const yyyy = String(now.getUTCFullYear()).padStart(4, '0');
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${siteSlug}/${kind}/${yyyy}/${mm}/${randomUUID()}.${STORAGE_EXTENSIONS[mime]}`;
}
