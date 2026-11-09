import 'server-only';

import { and, eq } from 'drizzle-orm';

import type { ListenStateDto } from '@/lib/api/dto';

import { findArticle, findFormatRow, lockArticle, requireCurrentRevision, upsertFormatDraft } from '../articles/repo';
import { notFound, type ActorContext } from '../articles/service';
import { getConfig } from '../config';
import { getDb } from '../db/client';
import { articleFormat } from '../db/schema';
import type { ListenPayload } from '../formats/payload';
import { ApiError } from '../http/api';
import { log } from '../log';
import { audioRefOf, deleteAssetIfUnreferenced, deleteStoredFiles } from '../media/cleanup';
import { cleanOriginalFilename, logMediaUpload, logUploadRejections, readUpload, storeUpload, type UploadRules } from '../media/ingest';
import { insertMediaAsset } from '../media/repo';
import { getCurrentSite } from '../site/current';
import { STORAGE_EXTENSIONS } from '../storage/types';
import { probeAudio } from './probe';
import { getListenState } from './sync';

// Audio ingest (spec/architecture.md §9.3, §9.5; spec/capabilities/listen-audio.md) on the shared
// media pipeline: size check → probe (type + duration from the bytes, never the name) → storage
// put → one transaction (media_asset row + the listen draft payload) → the replaced draft asset is
// deleted when no payload references it anymore (row in the transaction, file after commit). A DB
// failure after the put deletes the new file again. Upload ⇒ `ready`: the draft records
// uploadFingerprint = the current revision's paragraphs fingerprint (the text the recording is
// assumed to read); stored marks are cleared (they belonged to the old recording).

const LISTEN = 'listen';
const MIB = 1024 * 1024;

export interface AudioLimits {
  maxBytes: number;
  maxDurationMs: number;
}

export interface UploadAudioOptions {
  /** Defaults to getConfig() (BLOG0_MAX_AUDIO_MB / BLOG0_MAX_AUDIO_MINUTES); tests inject smaller ones. */
  limits?: AudioLimits;
  requestId?: string;
  now?: Date;
}

/** Limits from config at request time (spec/architecture.md §10). */
export function configuredAudioLimits(): AudioLimits {
  const config = getConfig();
  return { maxBytes: config.maxAudioMb * MIB, maxDurationMs: config.maxAudioMinutes * 60_000 };
}

function minutesOf(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  return `${Math.floor(totalSec / 60)} min ${(totalSec % 60).toString().padStart(2, '0')} s`;
}

function audioRules(maxBytes: number): UploadRules {
  const mb = maxBytes / MIB;
  const limit = Number.isInteger(mb) ? String(mb) : mb.toFixed(1);
  return {
    maxBytes,
    tooLarge: () => new ApiError('PAYLOAD_TOO_LARGE', 413, `The file is larger than the ${limit} MB limit for recordings.`),
    empty: () => new ApiError('UNSUPPORTED_MEDIA', 415, 'The file is empty; upload an mp3 or m4a.'),
  };
}

/**
 * Upload / replace the article's draft recording. Returns the Listen state (status `ready`, stored
 * marks cleared, uploadFingerprint = the current paragraphs fingerprint). The previous draft asset
 * is deleted unless a payload still references its key.
 */
export async function uploadAudio(articleId: string, file: File, actor: ActorContext, options: UploadAudioOptions = {}): Promise<ListenStateDto> {
  const limits = options.limits ?? configuredAudioLimits();
  const now = options.now ?? new Date();
  const rules = audioRules(limits.maxBytes);

  // The article must exist before any byte is read (a 404 is not an upload rejection).
  if (!(await findArticle(actor.siteId, articleId))) throw notFound(articleId);

  const context: Record<string, unknown> = { request_id: options.requestId, bytes: file.size, article_id: articleId, user_id: actor.user.id };
  const { probe, assetId, key, size, replacedAssetId, staleKey } = await logUploadRejections('audio', context, async () => {
    const buffer = await readUpload(file, rules);
    const probed = await probeAudio(buffer);
    if (!probed.ok) {
      if (probed.reason === 'no_duration') {
        throw new ApiError('UNSUPPORTED_MEDIA', 415, "Couldn't read the recording's length — re-export the file and try again.");
      }
      throw new ApiError('UNSUPPORTED_MEDIA', 415, `This file is ${probed.detected}; upload an mp3 or m4a.`);
    }
    const probe = probed.probe;
    context.mime = probe.mimeType;
    if (probe.durationMs > limits.maxDurationMs) {
      throw new ApiError(
        'AUDIO_TOO_LONG',
        422,
        `The recording is ${minutesOf(probe.durationMs)} long; the limit is ${Math.round(limits.maxDurationMs / 60_000)} minutes.`,
      );
    }
    const site = await getCurrentSite();
    // One transaction: media_asset row + listen draft (+ cleanup of the replaced draft asset).
    const committed = await storeUpload(
      { siteSlug: site.slug, kind: 'audio', mime: probe.mimeType, buffer, rules, now, requestId: options.requestId },
      (stored) =>
        getDb().transaction(async (tx) => {
          const row = await lockArticle(tx, actor.siteId, articleId);
          if (!row) throw notFound(articleId);
          const revision = await requireCurrentRevision(actor.siteId, row, tx);
          const asset = await insertMediaAsset(
            {
              siteId: actor.siteId,
              kind: 'audio',
              storageKey: stored.key,
              originalFilename: cleanOriginalFilename(file.name, `recording.${STORAGE_EXTENSIONS[probe.mimeType]}`),
              mimeType: probe.mimeType,
              byteSize: stored.size,
              sha256: stored.sha256,
              durationMs: probe.durationMs,
              articleId: row.id,
              createdBy: actor.user.id,
            },
            tx,
          );
          const payload: ListenPayload = {
            audio: { assetId: asset.id, key: stored.key, mimeType: probe.mimeType, bytes: stored.size, durationMs: probe.durationMs },
            marks: [],
            syncFingerprint: null,
            uploadFingerprint: revision.paragraphsFingerprint,
          };
          const previous = audioRefOf((await findFormatRow(actor.siteId, row.id, LISTEN, tx))?.draftPayload);
          await upsertFormatDraft(tx, actor.siteId, row.id, LISTEN, {
            draftPayload: payload,
            draftFingerprint: payload.uploadFingerprint,
            draftRevisionId: revision.id,
            draftUpdatedBy: actor.user.id,
            draftUpdatedAt: now,
            updatedAt: now,
          });
          // The draft now points at the new key; the old asset goes unless the published payload (or
          // any other payload of the site) still references it — the cleanup helper does that check.
          const replaced = previous && previous.assetId !== asset.id ? previous.assetId : null;
          const cleanup = replaced ? await deleteAssetIfUnreferenced(actor.siteId, replaced, { db: tx }) : null;
          return { assetId: asset.id, key: stored.key, size: stored.size, replacedAssetId: replaced, staleKey: cleanup?.key ?? null };
        }),
    );
    return { probe, ...committed };
  });
  // Committed: only now may the replaced recording's file go (spec/architecture.md §9.5).
  await deleteStoredFiles([staleKey], { requestId: options.requestId });

  logMediaUpload('audio', 'ok', {
    ...context,
    bytes: size,
    duration_ms: probe.durationMs,
    asset_id: assetId,
    key,
    replaced_asset_id: replacedAssetId,
  });
  return getListenState(actor.siteId, articleId);
}

/**
 * Remove the draft recording: payload → null (row kept), status `missing`. The published Listen is
 * untouched; the draft's file + row go unless a payload still references its key. Idempotent.
 */
export async function removeAudio(articleId: string, actor: ActorContext, options: { requestId?: string; now?: Date } = {}): Promise<ListenStateDto> {
  const now = options.now ?? new Date();
  const removed = await getDb().transaction(async (tx) => {
    const row = await lockArticle(tx, actor.siteId, articleId);
    if (!row) throw notFound(articleId);
    const format = await findFormatRow(actor.siteId, row.id, LISTEN, tx);
    const draft = audioRefOf(format?.draftPayload);
    if (!format || !draft) return null;
    await tx
      .update(articleFormat)
      .set({ draftPayload: null, draftFingerprint: null, draftRevisionId: null, draftUpdatedBy: actor.user.id, draftUpdatedAt: now, updatedAt: now })
      .where(and(eq(articleFormat.id, format.id), eq(articleFormat.siteId, actor.siteId)));
    const cleanup = await deleteAssetIfUnreferenced(actor.siteId, draft.assetId, { db: tx });
    return { ...draft, staleKey: cleanup.key };
  });
  if (removed) {
    await deleteStoredFiles([removed.staleKey], { requestId: options.requestId });
    log.info('media.remove', { msg: 'audio draft removed', request_id: options.requestId, article_id: articleId, asset_id: removed.assetId, user_id: actor.user.id });
  }
  return getListenState(actor.siteId, articleId);
}
