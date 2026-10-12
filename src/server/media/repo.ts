import 'server-only';

import { and, eq } from 'drizzle-orm';

import { getDb, type Executor } from '../db/client';
import { mediaAsset, type MediaAssetRow } from '../db/schema';
import { isUuid } from '../articles/repo';

// Data access for media_asset (spec/data.md). Every query filters by site id.

export interface NewMediaAsset {
  siteId: string;
  kind: 'image' | 'audio';
  storageKey: string;
  originalFilename: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  /** Audio only; stored as whole milliseconds / 1000 in `duration_sec`. */
  durationMs?: number | null;
  width?: number | null;
  height?: number | null;
  articleId?: string | null;
  createdBy: string;
}

export async function insertMediaAsset(input: NewMediaAsset, db: Executor = getDb()): Promise<MediaAssetRow> {
  const [row] = await db
    .insert(mediaAsset)
    .values({
      siteId: input.siteId,
      kind: input.kind,
      storageKey: input.storageKey,
      originalFilename: input.originalFilename,
      mimeType: input.mimeType,
      byteSize: input.byteSize,
      sha256: input.sha256,
      durationSec: input.durationMs == null ? null : Math.round(input.durationMs) / 1000,
      width: input.width ?? null,
      height: input.height ?? null,
      articleId: input.articleId ?? null,
      createdBy: input.createdBy,
    })
    .returning();
  return row;
}

export async function findMediaAssetByKey(siteId: string, storageKey: string, db: Executor = getDb()): Promise<MediaAssetRow | null> {
  const [row] = await db
    .select()
    .from(mediaAsset)
    .where(and(eq(mediaAsset.siteId, siteId), eq(mediaAsset.storageKey, storageKey)))
    .limit(1);
  return row ?? null;
}

export async function findMediaAsset(siteId: string, id: string, db: Executor = getDb()): Promise<MediaAssetRow | null> {
  if (!isUuid(id)) return null;
  const [row] = await db
    .select()
    .from(mediaAsset)
    .where(and(eq(mediaAsset.siteId, siteId), eq(mediaAsset.id, id)))
    .limit(1);
  return row ?? null;
}

export async function deleteMediaAssetRow(siteId: string, id: string, db: Executor = getDb()): Promise<boolean> {
  if (!isUuid(id)) return false;
  const rows = await db
    .delete(mediaAsset)
    .where(and(eq(mediaAsset.siteId, siteId), eq(mediaAsset.id, id)))
    .returning({ id: mediaAsset.id });
  return rows.length > 0;
}
