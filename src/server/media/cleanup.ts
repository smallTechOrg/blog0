import 'server-only';

import { and, eq, or, sql } from 'drizzle-orm';

import { getDb } from '../db/client';
import { articleFormat } from '../db/schema';
import { log } from '../log';
import { getStorage } from '../storage';
import { StorageError } from '../storage/types';
import { deleteMediaAssetRow, findMediaAsset, type Executor } from './repo';

// deleteAssetIfUnreferenced (spec/data.md media_asset rules; spec/architecture.md §9): an audio
// row and its file go away when the recording is replaced or removed and no article_format
// draft/published payload still references its storage key. Image rows are never deleted
// automatically in v0.1 (the caller decides; this helper applies the same reference check to
// any kind). Idempotent: a missing row or file resolves.

export type CleanupOutcome = 'deleted' | 'referenced' | 'missing';

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

export async function deleteAssetIfUnreferenced(
  siteId: string,
  assetId: string,
  opts: { requestId?: string; db?: Executor } = {},
): Promise<CleanupOutcome> {
  const db = opts.db ?? getDb();
  const row = await findMediaAsset(siteId, assetId, db);
  if (!row) return 'missing';
  if (await isStorageKeyReferenced(siteId, row.storageKey, db)) return 'referenced';
  await deleteMediaAssetRow(siteId, row.id, db);
  try {
    await getStorage().delete(row.storageKey);
  } catch (error) {
    // The row is gone; a leftover file is an orphan, not a failure of the caller's operation.
    const message = error instanceof StorageError ? `${error.code}: ${error.message}` : (error as Error).message;
    log.warn('media.cleanup', { msg: `Could not delete file for media asset ${row.id}`, request_id: opts.requestId, key: row.storageKey, err_message: message });
  }
  return 'deleted';
}
