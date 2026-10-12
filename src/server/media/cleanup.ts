import 'server-only';

import { and, eq, or, sql } from 'drizzle-orm';

import { getDb } from '../db/client';
import { articleFormat } from '../db/schema';
import { log } from '../log';
import { getStorage } from '../storage';
import { StorageError } from '../storage/types';
import { deleteMediaAssetRow, findMediaAsset, type Executor } from './repo';

// Media cleanup (spec/data.md media_asset rules; spec/architecture.md §9.5): an audio row and its
// file go away when the recording is replaced, removed or superseded by a publish and no
// article_format draft/published payload still references its storage key. Image rows are never
// deleted automatically in v0.1 (the caller decides; the same reference check applies to any kind).
//
// Two steps so a rolled-back transaction never loses a file a surviving row points at:
//   1. `deleteAssetIfUnreferenced(…, { db: tx })` — reference check + row delete INSIDE the
//      caller's transaction; returns the storage key whose file must go.
//   2. `deleteStoredFiles(keys)` — AFTER the transaction committed. A file that can't be deleted
//      is an orphan (logged), never a failure of the caller's operation.
// Both are idempotent: a missing row or file resolves.

export type CleanupOutcome = 'deleted' | 'referenced' | 'missing';

export interface CleanupResult {
  outcome: CleanupOutcome;
  /** The storage key whose file the caller deletes after commit — set only when `outcome === 'deleted'`. */
  key: string | null;
}

/** Reads `{ assetId, key }` out of a stored listen payload without depending on the full schema. */
export function audioRefOf(payload: unknown): { assetId: string; key: string } | null {
  const audio = (payload as { audio?: { assetId?: unknown; key?: unknown } } | null)?.audio;
  if (!audio || typeof audio.assetId !== 'string' || typeof audio.key !== 'string') return null;
  return { assetId: audio.assetId, key: audio.key };
}

/** True when some article_format payload (draft or published) carries `audio.key === key`. */
export async function isStorageKeyReferenced(siteId: string, key: string, db: Executor = getDb()): Promise<boolean> {
  const [row] = await db
    .select({ id: articleFormat.id })
    .from(articleFormat)
    .where(
      and(
        eq(articleFormat.siteId, siteId),
        or(sql`${articleFormat.draftPayload} -> 'audio' ->> 'key' = ${key}`, sql`${articleFormat.publishedPayload} -> 'audio' ->> 'key' = ${key}`),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Deletes the media_asset ROW when no payload references its key (run it inside the caller's
 * transaction via `opts.db`). The file is NOT touched: pass the returned key to
 * `deleteStoredFiles` once the transaction has committed.
 */
export async function deleteAssetIfUnreferenced(siteId: string, assetId: string, opts: { db?: Executor } = {}): Promise<CleanupResult> {
  const db = opts.db ?? getDb();
  const row = await findMediaAsset(siteId, assetId, db);
  if (!row) return { outcome: 'missing', key: null };
  if (await isStorageKeyReferenced(siteId, row.storageKey, db)) return { outcome: 'referenced', key: null };
  await deleteMediaAssetRow(siteId, row.id, db);
  return { outcome: 'deleted', key: row.storageKey };
}

/** Deletes files whose rows are gone — call only after the deleting transaction committed. Never throws. */
export async function deleteStoredFiles(keys: ReadonlyArray<string | null | undefined>, opts: { requestId?: string } = {}): Promise<void> {
  for (const key of keys) {
    if (!key) continue;
    try {
      await getStorage().delete(key);
    } catch (error) {
      const message = error instanceof StorageError ? `${error.code}: ${error.message}` : (error as Error).message;
      log.warn('media.cleanup', { msg: `Could not delete media file ${key}`, request_id: opts.requestId, key, err_message: message });
    }
  }
}
