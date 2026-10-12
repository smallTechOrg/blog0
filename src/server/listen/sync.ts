import 'server-only';

import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { ListenAudioDto, ListenStateDto, MarksInvalidDetails } from '@/lib/api/dto-phase3';
import { LISTEN_NO_AUDIO, MARKS_INVALID } from '@/lib/api/dto-phase3';
import { resolveMarks, toTimedParagraphs } from '@/lib/listen/estimate';
import { validateMarks } from '@/lib/listen/marks';

import { findArticle, findFormatRow, lockArticle, userNames, type Executor } from '../articles/repo';
import { notFound, type ActorContext } from '../articles/service';
import { renderRevision, requireCurrentRevision } from '../articles/views';
import { getConfig } from '../config';
import { getDb } from '../db/client';
import { articleFormat, mediaAsset, type ArticleRow } from '../db/schema';
import { listenAdapter, listenBaseline, readListenPayload, type ListenPayload } from '../formats';
import { ApiError } from '../http/api';
import { log } from '../log';

// Listen sync service (spec/architecture.md §9.5, revised by the Phase 3 fix): the Listen state for
// the editor tab, and the ALIGNER-FACING marks save (PUT …/listen — Phase 6 writes aligned marks
// here; no admin UI calls it). Marks are validated against the CURRENT revision's paragraph list
// and the draft recording's duration; a save stores them with `syncFingerprint` = that revision's
// paragraphs fingerprint and never touches the upload baseline (uploadFingerprint /
// draft_fingerprint), so a PUT never changes the status. Never touches storage, never calls the LLM.

const LISTEN = 'listen';
const UNKNOWN_USER = 'Unknown';
/** Payload cap only; the real rules (one per paragraph …) are MARKS_INVALID, not VALIDATION_FAILED. */
const MARKS_MAX = 5_000;

export const listenSaveBody = z.object({
  revisionId: z.string().trim().min(1).max(64),
  marks: z
    .array(
      z.object({
        pid: z.string().trim().min(1).max(64),
        // Integer/range rules are a marks rule → 422 MARKS_INVALID (OUT_OF_RANGE), so any finite number parses.
        tMs: z.number().finite(),
      }),
    )
    .max(MARKS_MAX),
});
export type ListenSaveBody = z.infer<typeof listenSaveBody>;

function conflict(): ApiError {
  return new ApiError('CONFLICT', 409, 'The article changed since you opened it — reload to sync against the latest saved version.');
}

async function audioDto(siteId: string, audio: ListenPayload['audio'], db: Executor): Promise<ListenAudioDto> {
  const [asset] = await db
    .select()
    .from(mediaAsset)
    .where(and(eq(mediaAsset.siteId, siteId), eq(mediaAsset.id, audio.assetId)))
    .limit(1);
  const names = asset ? await userNames(siteId, [asset.createdBy], db) : new Map<string, string>();
  return {
    assetId: audio.assetId,
    key: audio.key,
    url: `/media/${audio.key}`,
    mimeType: audio.mimeType,
    bytes: audio.bytes,
    durationMs: audio.durationMs,
    originalFilename: asset?.originalFilename ?? '',
    uploadedAt: (asset?.createdAt ?? new Date(0)).toISOString(),
    uploadedBy: (asset && names.get(asset.createdBy)) || UNKNOWN_USER,
  };
}

export async function buildListenState(siteId: string, row: ArticleRow, now: Date = new Date(), db: Executor = getDb()): Promise<ListenStateDto> {
  const revision = await requireCurrentRevision(siteId, row, db);
  const [rendered, formatRow] = await Promise.all([renderRevision(revision), findFormatRow(siteId, row.id, LISTEN, db)]);
  const draft = readListenPayload(formatRow?.draftPayload);
  const published = readListenPayload(formatRow?.publishedPayload);
  const status = listenAdapter.computeStatus({ row: formatRow, currentRevision: revision, now }) as ListenStateDto['status'];
  const synced = draft !== null && draft.marks.length > 0;
  const names = await userNames(siteId, [synced ? formatRow?.draftUpdatedBy : null], db);
  const config = getConfig();

  return {
    status,
    revisionId: revision.id,
    paragraphs: rendered.paragraphs.map((p) => ({ pid: p.pid, index: p.index, text: p.text, kind: p.kind, headingPath: [...p.headingPath] })),
    audio: draft ? await audioDto(siteId, draft.audio, db) : null,
    marks: draft ? draft.marks.map((m) => ({ pid: m.pid, tMs: m.tMs })) : [],
    timing: draft ? resolveMarks(draft.marks, toTimedParagraphs(rendered.paragraphs), draft.audio.durationMs).timing : null,
    uploadFingerprint: draft ? listenBaseline(draft) : null,
    textChangedSinceUpload: status === 'text_changed',
    syncFingerprint: draft?.syncFingerprint ?? null,
    syncedAt: synced ? (formatRow?.draftUpdatedAt?.toISOString() ?? null) : null,
    syncedBy: synced ? (formatRow?.draftUpdatedBy && names.get(formatRow.draftUpdatedBy)) || UNKNOWN_USER : null,
    published:
      formatRow && published && formatRow.publishedAt
        ? {
            durationMs: published.audio.durationMs,
            publishedAt: formatRow.publishedAt.toISOString(),
            sameAudioAsDraft: draft !== null && published.audio.key === draft.audio.key,
          }
        : null,
    limits: { maxAudioMb: config.maxAudioMb, maxAudioMinutes: config.maxAudioMinutes },
  };
}

export async function getListenState(siteId: string, id: string): Promise<ListenStateDto> {
  const row = await findArticle(siteId, id);
  if (!row) throw notFound(id);
  return buildListenState(siteId, row);
}

/**
 * Aligner-facing save: the complete mark set for the current revision (spec/capabilities/
 * listen-sync.md). Stores marks + syncFingerprint + syncedAt/By + draft_revision_id; leaves
 * uploadFingerprint and draft_fingerprint alone (a legacy payload's baseline is materialised as its
 * uploadFingerprint first, so the status never changes).
 */
export async function saveMarks(ctx: ActorContext, id: string, body: ListenSaveBody): Promise<ListenStateDto> {
  await getDb().transaction(async (tx) => {
    const row = await lockArticle(tx, ctx.siteId, id);
    if (!row) throw notFound(id);
    if (row.currentRevisionId !== body.revisionId) throw conflict();
    const revision = await requireCurrentRevision(ctx.siteId, row, tx);
    const rendered = await renderRevision(revision);

    const formatRow = await findFormatRow(ctx.siteId, id, LISTEN, tx);
    const draft = readListenPayload(formatRow?.draftPayload);
    if (!formatRow || !draft) {
      throw new ApiError(LISTEN_NO_AUDIO, 409, 'Upload a recording before syncing — there is no draft audio for this article.');
    }

    const pids = rendered.paragraphs.map((p) => p.pid);
    const check = validateMarks(body.marks, pids, draft.audio.durationMs);
    if (!check.ok) {
      const n = check.reasons.length;
      throw new ApiError(
        MARKS_INVALID,
        422,
        `The sync can't be saved: ${n} problem${n === 1 ? '' : 's'} with the marks (one mark per paragraph, in order, strictly increasing, inside the recording).`,
        { reasons: check.reasons } satisfies MarksInvalidDetails,
      );
    }

    const payload: ListenPayload = {
      audio: draft.audio,
      marks: body.marks.map((m) => ({ pid: m.pid, tMs: m.tMs })),
      syncFingerprint: revision.paragraphsFingerprint,
      uploadFingerprint: listenBaseline(draft),
    };
    await tx
      .update(articleFormat)
      .set({
        draftPayload: payload,
        draftRevisionId: revision.id,
        draftUpdatedBy: ctx.user.id,
        draftUpdatedAt: new Date(),
      })
      .where(and(eq(articleFormat.id, formatRow.id), eq(articleFormat.siteId, ctx.siteId)));
    log.info('listen.sync', { article_id: row.id, revision_id: revision.id, marks: payload.marks.length, user_id: ctx.user.id });
  });
  return getListenState(ctx.siteId, id);
}
