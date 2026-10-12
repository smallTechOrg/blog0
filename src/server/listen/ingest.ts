import 'server-only';

import { and, eq, sql } from 'drizzle-orm';

import type { ListenStateDto } from '@/lib/api/dto-phase3';

import type { ActorContext } from '../articles/service';
import { notFound } from '../articles/service';
import { findArticle, findFormatRow, lockArticle } from '../articles/repo';
import { getConfig } from '../config';
import { getDb, type Tx } from '../db/client';
import { articleFormat } from '../db/schema';
import { ApiError } from '../http/api';
import { log } from '../log';
import { audioRefOf, deleteAssetIfUnreferenced, deleteStoredFiles } from '../media/cleanup';
import { insertMediaAsset } from '../media/repo';
import { getCurrentSite } from '../site/current';
import { getStorage, makeStorageKey, StorageError } from '../storage';
import { audioExtension, probeAudio, type AudioMime } from './probe';
import { getListenState } from './sync';

// Audio ingest (spec/architecture.md §9.3, §9.5; spec/capabilities/listen-audio.md): size check →
// probe (type + duration from the bytes, never the name) → storage put → one transaction
// (media_asset row + the listen draft payload) → the replaced draft asset is deleted when no
// payload references it anymore (row in the transaction, file after commit). A DB failure after
// the put deletes the new file again.

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

/** The `audio` part of ListenPayload (spec/data.md); S3.3's listenPayloadSchema validates the whole shape. */
export interface ListenAudioPart {
  assetId: string;
  key: string;
  mimeType: AudioMime;
  bytes: number;
  durationMs: number;
}

interface ListenDraftPayload {
  audio: ListenAudioPart;
  marks: Array<{ pid: string; tMs: number }>;
  syncFingerprint: string | null;
}

/** Limits from config at request time (spec/architecture.md §10). */
export function configuredAudioLimits(): AudioLimits {
  const config = getConfig();
  return { maxBytes: config.maxAudioMb * MIB, maxDurationMs: config.maxAudioMinutes * 60_000 };
}

function mbOf(bytes: number): string {
  const mb = bytes / MIB;
  return Number.isInteger(mb) ? String(mb) : mb.toFixed(1);
}

function minutesOf(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  return `${Math.floor(totalSec / 60)} min ${(totalSec % 60).toString().padStart(2, '0')} s`;
}

function tooLarge(maxBytes: number): ApiError {
  return new ApiError('PAYLOAD_TOO_LARGE', 413, `The file is larger than the ${mbOf(maxBytes)} MB limit for recordings.`);
}

export { audioRefOf };

/** Status codes that count as a rejected upload in the `media.upload` log (spec/architecture.md §7). */
const REJECTED_STATUSES = new Set([413, 415, 422]);

/** Basename only, control characters stripped, ≤ 255 chars (spec/data.md → media_asset). */
export function cleanFilename(name: string, fallback: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255);
  return cleaned === '' ? fallback : cleaned;
}

/** Reads the multipart File into memory; the byte limit is enforced before and after reading. */
async function readUpload(file: File, maxBytes: number): Promise<Buffer> {
  if (file.size > maxBytes) throw tooLarge(maxBytes);
  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.byteLength > maxBytes) throw tooLarge(maxBytes);
  if (buf.byteLength === 0) throw new ApiError('UNSUPPORTED_MEDIA', 415, 'The file is empty; upload an mp3 or m4a.');
  return buf;
}

async function probeOrThrow(buf: Buffer, limits: AudioLimits, seen: { mime: AudioMime | null }) {
  const result = await probeAudio(buf);
  if (result.ok) seen.mime = result.probe.mimeType;
  if (!result.ok) {
    if (result.reason === 'no_duration') {
      throw new ApiError('UNSUPPORTED_MEDIA', 415, "Couldn't read the recording's length — re-export the file and try again.");
    }
    throw new ApiError('UNSUPPORTED_MEDIA', 415, `This file is ${result.detected}; upload an mp3 or m4a.`);
  }
  if (result.probe.durationMs > limits.maxDurationMs) {
    throw new ApiError(
      'AUDIO_TOO_LONG',
      422,
      `The recording is ${minutesOf(result.probe.durationMs)} long; the limit is ${Math.round(limits.maxDurationMs / 60_000)} minutes.`,
    );
  }
  return result.probe;
}

/**
 * Upload / replace the article's draft recording. Returns the Listen state (status `needs_sync`,
 * marks cleared). The previous draft asset is deleted unless a payload still references its key.
 */
export async function uploadAudio(articleId: string, file: File, actor: ActorContext, options: UploadAudioOptions = {}): Promise<ListenStateDto> {
  const seen: { mime: AudioMime | null } = { mime: null };
  try {
    return await storeAudio(articleId, file, actor, options, seen);
  } catch (error) {
    if (error instanceof ApiError && REJECTED_STATUSES.has(error.status)) {
      log.info('media.upload', {
        msg: `media.upload audio rejected ${error.code}`,
        request_id: options.requestId,
        kind: 'audio',
        mime: seen.mime ?? undefined,
        bytes: file.size,
        article_id: articleId,
        outcome: 'rejected',
        err_code: error.code,
        user_id: actor.user.id,
      });
    }
    throw error;
  }
}

async function storeAudio(
  articleId: string,
  file: File,
  actor: ActorContext,
  options: UploadAudioOptions,
  seen: { mime: AudioMime | null },
): Promise<ListenStateDto> {
  const limits = options.limits ?? configuredAudioLimits();
  const now = options.now ?? new Date();
  const db = getDb();

  // 1. The article must exist before any byte is read.
  if (!(await findArticle(actor.siteId, articleId))) throw notFound(articleId);

  // 2. Size → probe → put (nothing touches the DB yet).
  const buf = await readUpload(file, limits.maxBytes);
  const probe = await probeOrThrow(buf, limits, seen);
  const site = await getCurrentSite();
  const key = makeStorageKey(site.slug, 'audio', probe.mimeType, now);
  const storage = getStorage();
  let stored;
  try {
    stored = await storage.put(key, buf, { maxBytes: limits.maxBytes });
  } catch (error) {
    if (error instanceof StorageError && error.code === 'TOO_LARGE') throw tooLarge(limits.maxBytes);
    log.error('media.upload', {
      msg: 'storage put failed',
      request_id: options.requestId,
      article_id: articleId,
      key,
      err_message: error instanceof Error ? error.message : String(error),
    });
    throw new ApiError('INTERNAL', 500, "Couldn't store the file — try again; if it keeps happening, check the server log.");
  }

  // 3. One transaction: media_asset row + listen draft (+ cleanup of the replaced draft asset).
  let replacedAssetId: string | null = null;
  let staleKey: string | null = null;
  let assetId: string;
  try {
    assetId = await db.transaction(async (tx) => {
      const row = await lockArticle(tx, actor.siteId, articleId);
      if (!row) throw notFound(articleId);
      const asset = await insertMediaAsset(
        {
          siteId: actor.siteId,
          kind: 'audio',
          storageKey: stored.key,
          originalFilename: cleanFilename(file.name, `recording.${audioExtension(probe.mimeType)}`),
          mimeType: probe.mimeType,
          byteSize: stored.size,
          sha256: stored.sha256,
          durationMs: probe.durationMs,
          articleId: row.id,
          createdBy: actor.user.id,
        },
        tx,
      );
      const payload: ListenDraftPayload = {
        audio: { assetId: asset.id, key: stored.key, mimeType: probe.mimeType, bytes: stored.size, durationMs: probe.durationMs },
        marks: [],
        syncFingerprint: null,
      };
      const format = await findFormatRow(actor.siteId, row.id, LISTEN, tx);
      const previous = audioRefOf(format?.draftPayload);
      await upsertListenDraft(tx, { siteId: actor.siteId, articleId: row.id, existingId: format?.id ?? null, payload, userId: actor.user.id, now });
      // The draft now points at the new key; the old asset goes unless the published payload (or any
      // other payload of the site) still references it — the cleanup helper does that check.
      if (previous && previous.assetId !== asset.id) {
        replacedAssetId = previous.assetId;
        staleKey = (await deleteAssetIfUnreferenced(actor.siteId, previous.assetId, { db: tx })).key;
      }
      return asset.id;
    });
  } catch (error) {
    await storage.delete(stored.key).catch(() => {});
    throw error;
  }
  // Committed: only now may the replaced recording's file go (spec/architecture.md §9.5).
  await deleteStoredFiles([staleKey], { requestId: options.requestId });

  log.info('media.upload', {
    msg: `media.upload audio ok ${probe.mimeType} ${stored.size} B ${probe.durationMs} ms`,
    request_id: options.requestId,
    kind: 'audio',
    mime: probe.mimeType,
    bytes: stored.size,
    duration_ms: probe.durationMs,
    article_id: articleId,
    outcome: 'ok',
    asset_id: assetId,
    key: stored.key,
    replaced_asset_id: replacedAssetId,
    user_id: actor.user.id,
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

async function upsertListenDraft(
  tx: Tx,
  args: { siteId: string; articleId: string; existingId: string | null; payload: ListenDraftPayload; userId: string; now: Date },
): Promise<void> {
  const draft = {
    draftPayload: args.payload,
    draftFingerprint: null,
    draftRevisionId: null,
    draftUpdatedBy: args.userId,
    draftUpdatedAt: args.now,
    updatedAt: args.now,
  };
  if (args.existingId) {
    await tx
      .update(articleFormat)
      .set(draft)
      .where(and(eq(articleFormat.id, args.existingId), eq(articleFormat.siteId, args.siteId)));
    return;
  }
  // Unique (article_id, kind): a concurrent first upload loses the race cleanly.
  await tx
    .insert(articleFormat)
    .values({ siteId: args.siteId, articleId: args.articleId, kind: LISTEN, ...draft })
    .onConflictDoUpdate({ target: [articleFormat.articleId, articleFormat.kind], set: { ...draft, updatedAt: sql`now()` } });
}
