import 'server-only';

import { and, desc, eq, sql } from 'drizzle-orm';

import type { MediaLibraryItemDto, MediaUsageDto } from '@/lib/api/dto';

import { ApiError } from '../http/api';
import { clearRenderCache } from '../content';
import { getDb, rowsOf } from '../db/client';
import { appUser, mediaAsset, type MediaAssetRow } from '../db/schema';
import { log } from '../log';
import { getStorage } from '../storage';
import { StorageError } from '../storage/types';
import { probeImage } from './image-probe';
import { cleanOriginalFilename, readUpload, type UploadRules } from './ingest';
import { findMediaAsset } from './repo';

// Media library (images): every uploaded image with the articles that show it, and "replace" —
// new bytes behind the SAME `/media/<key>` address, so every article that uses the image shows the
// new one without being edited. Images are served revalidated (src/app/media), so a replacement
// reaches readers on their next view; the render cache is cleared because it holds the old size.

export const MEDIA_PREFIX = '/media/';

interface UsageRow { asset_id: string; article_id: string; slug: string; status: string; title: string }

function toDto(row: MediaAssetRow, uploadedBy: string, usedIn: MediaUsageDto[]): MediaLibraryItemDto {
  return {
    id: row.id,
    key: row.storageKey,
    url: MEDIA_PREFIX + row.storageKey,
    filename: row.originalFilename,
    mimeType: row.mimeType,
    bytes: row.byteSize,
    width: row.width,
    height: row.height,
    createdAt: row.createdAt.toISOString(),
    uploadedBy,
    usedIn,
  };
}

/**
 * The articles whose CURRENT or PUBLISHED revision's Markdown contains each asset's `/media/<key>`.
 * One query for the whole site (a plain substring test, not LIKE, so `_`/`%` in keys are literal).
 */
async function usageByAsset(siteId: string, assetId?: string): Promise<Map<string, MediaUsageDto[]>> {
  const only = assetId ? sql`and m.id = ${assetId}` : sql``;
  const result = await getDb().execute(sql`
    select distinct m.id as asset_id, a.id as article_id, a.slug as slug, a.status as status, cur.title as title, a.updated_at as updated_at
    from media_asset m
    join article_revision r on r.site_id = m.site_id and position(${MEDIA_PREFIX} || m.storage_key in r.body_md) > 0
    join article a on a.id = r.article_id and (a.current_revision_id = r.id or a.published_revision_id = r.id)
    join article_revision cur on cur.id = a.current_revision_id
    where m.site_id = ${siteId} and m.kind = 'image' ${only}
    order by a.updated_at desc
  `);
  const out = new Map<string, MediaUsageDto[]>();
  for (const r of rowsOf<UsageRow>(result)) {
    const list = out.get(r.asset_id) ?? [];
    list.push({ articleId: r.article_id, slug: r.slug, title: r.title, status: r.status === 'published' ? 'published' : 'draft' });
    out.set(r.asset_id, list);
  }
  return out;
}

/** Every image of the site, newest upload first, each with the articles that show it. */
export async function listImageLibrary(siteId: string): Promise<MediaLibraryItemDto[]> {
  const rows = await getDb()
    .select({ asset: mediaAsset, uploadedBy: appUser.displayName })
    .from(mediaAsset)
    .innerJoin(appUser, eq(appUser.id, mediaAsset.createdBy))
    .where(and(eq(mediaAsset.siteId, siteId), eq(mediaAsset.kind, 'image')))
    .orderBy(desc(mediaAsset.createdAt), desc(mediaAsset.id));
  const usage = await usageByAsset(siteId);
  return rows.map((r) => toDto(r.asset, r.uploadedBy, usage.get(r.asset.id) ?? []));
}

async function itemFor(siteId: string, row: MediaAssetRow): Promise<MediaLibraryItemDto> {
  const [who] = await getDb().select({ name: appUser.displayName }).from(appUser).where(eq(appUser.id, row.createdBy)).limit(1);
  return toDto(row, who?.name ?? 'Unknown', (await usageByAsset(siteId, row.id)).get(row.id) ?? []);
}

export interface ReplaceImageInput {
  siteId: string;
  assetId: string;
  file: File;
  rules: UploadRules;
  requestId?: string;
}

/**
 * Puts the new image's bytes under the asset's existing storage key and updates its row (type,
 * size, hash, dimensions, filename). The key — so every article's `/media/<key>` — is unchanged.
 * If the row update fails the old bytes are put back, so a file never disagrees with its row.
 */
export async function replaceImage(input: ReplaceImageInput): Promise<MediaLibraryItemDto> {
  const { siteId, assetId, file, rules } = input;
  const row = await findMediaAsset(siteId, assetId);
  if (!row || row.kind !== 'image') throw new ApiError('NOT_FOUND', 404, 'No such image.');

  const buffer = await readUpload(file, rules);
  const probe = probeImage(buffer);

  const storage = getStorage();
  const previous = await storage.get(row.storageKey);
  try {
    const stored = await storage.put(row.storageKey, buffer, { maxBytes: rules.maxBytes });
    try {
      const [saved] = await getDb()
        .update(mediaAsset)
        .set({
          mimeType: probe.mime,
          byteSize: stored.size,
          sha256: stored.sha256,
          width: probe.width,
          height: probe.height,
          originalFilename: cleanOriginalFilename(file.name),
        })
        .where(and(eq(mediaAsset.siteId, siteId), eq(mediaAsset.id, assetId)))
        .returning();
      clearRenderCache();
      log.info('media.replace', {
        msg: 'media.replace image ok',
        request_id: input.requestId,
        asset_id: assetId,
        key: row.storageKey,
        mime: probe.mime,
        bytes: stored.size,
        width: probe.width,
        height: probe.height,
      });
      return itemFor(siteId, saved);
    } catch (error) {
      if (previous) {
        await storage.put(row.storageKey, previous, { maxBytes: previous.length + 1 }).catch((e: unknown) => {
          log.error('media.replace', { msg: 'Could not restore the previous file after a failed replace', key: row.storageKey, err_message: (e as Error).message });
        });
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof StorageError && error.code === 'TOO_LARGE') throw rules.tooLarge();
    log.error('media.replace', { msg: 'replace failed', request_id: input.requestId, key: row.storageKey, err_message: (error as Error).message });
    throw new ApiError('INTERNAL', 500, "Couldn't replace the file — try again; if it keeps happening, check the server log.");
  }
}
