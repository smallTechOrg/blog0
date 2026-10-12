import 'server-only';

import { and, eq } from 'drizzle-orm';

import type { DeckInvalidDetails, GenerationDto, TldrStateDto } from '@/lib/api/dto';

import { getConfig } from '../config';
import { getDb, type Tx } from '../db/client';
import { aiGeneration, articleFormat, type AiGenerationRow } from '../db/schema';
import { GENERATION_STALE_MS, isGenerationActive, readTldrPayload, TLDR_MAX_SLIDES, TLDR_MIN_SLIDES, type TldrPayload } from '../formats';
import { ApiError } from '../http/api';
import { computeBounds } from '../jev/bounds';
import { guardInput, jevInputFromRendered } from '../jev/build-input';
import { JEV_PROMPT_VERSION } from '../jev/prompt';
import { runJev } from '../jev/run';
import type { JevErrorCode, JevResult } from '../jev/state';
import { getLlmClient } from '../llm';
import type { LlmClient } from '../llm/types';
import { getCurrentSite } from '../site/current';
import { findArticle, findFormatRow, latestGeneration, lockArticle, userNames } from './repo';
import type { SaveDeckBody } from './schemas';
import { notFound, type ActorContext } from './service';
import { buildTldrState, renderRevision, requireCurrentRevision, toGenerationDto } from './views';

// TLDR orchestration (spec/architecture.md §3 "Generate", "Deck edit"): the generation row, the
// Jev call and the draft deck. Jev only returns indices; every slide's text is taken from the
// server's own sentence list.

const TLDR = 'tldr';
const TASK = 'tldr.select';

/** HTTP status per Jev/LLM error code (spec/api.md → Error codes). */
export const JEV_ERROR_STATUS: Record<JevErrorCode, number> = {
  JEV_NO_SENTENCES: 422,
  JEV_INPUT_TOO_LONG: 422,
  LLM_AUTH: 502,
  LLM_INSUFFICIENT_CREDITS: 502,
  LLM_MODEL_NOT_FOUND: 502,
  LLM_INVALID_OUTPUT: 502,
  LLM_RATE_LIMITED: 503,
  LLM_UNAVAILABLE: 503,
  LLM_TIMEOUT: 503,
};

// ---------------------------------------------------------------------------------------------
// Test seam: error-path/structure tests may swap the LLM transport. Never used on real-key paths.
// ---------------------------------------------------------------------------------------------

export interface JevDepsOverride {
  llm?: LlmClient;
  model?: string;
}

let depsOverride: JevDepsOverride | null = null;

export function setJevDepsForTests(override: JevDepsOverride): void {
  depsOverride = override;
}

export function resetJevDepsForTests(): void {
  depsOverride = null;
}

// ---------------------------------------------------------------------------------------------

export async function getTldrState(siteId: string, id: string): Promise<TldrStateDto> {
  const row = await findArticle(siteId, id);
  if (!row) throw notFound(id);
  return buildTldrState(siteId, row);
}

function conflict(): ApiError {
  return new ApiError('CONFLICT', 409, 'The article changed since you opened it — reload to work on the latest saved version.');
}

export async function generateTldr(
  ctx: ActorContext,
  id: string,
  revisionId: string,
  requestId: string,
): Promise<{ tldr: TldrStateDto; generation: GenerationDto }> {
  const db = getDb();
  const config = getConfig();
  const model = depsOverride?.model ?? config.jevModel;

  // 1. Revision must be current; guard the input BEFORE any row or call exists.
  const row = await findArticle(ctx.siteId, id);
  if (!row) throw notFound(id);
  if (row.currentRevisionId !== revisionId) throw conflict();
  const revision = await requireCurrentRevision(ctx.siteId, row);
  const rendered = await renderRevision(revision);
  const input = jevInputFromRendered({
    articleId: row.id,
    revisionId: revision.id,
    title: revision.title,
    dek: revision.dek,
    rendered,
    requestId,
  });
  const bounds = computeBounds(input.sentences);
  const guard = guardInput(input, bounds);
  if (guard) throw new ApiError(guard.code, JEV_ERROR_STATUS[guard.code], guard.message);

  // 2. One run per article: lock the article row, refuse while a young `running` row exists.
  const now = new Date();
  const generation = await db.transaction(async (tx) => {
    const locked = await lockArticle(tx, ctx.siteId, id);
    if (!locked) throw notFound(id);
    if (locked.currentRevisionId !== revisionId) throw conflict();
    const latest = await latestGeneration(ctx.siteId, id, TLDR, tx);
    if (isGenerationActive(latest, now)) {
      throw new ApiError(
        'GENERATION_IN_PROGRESS',
        409,
        'Jev is already working on this article — wait for it to finish.',
        { generationId: latest!.id, retryAfterSec: Math.ceil((GENERATION_STALE_MS - (now.getTime() - latest!.startedAt.getTime())) / 1000) },
      );
    }
    const [inserted] = await tx
      .insert(aiGeneration)
      .values({
        siteId: ctx.siteId,
        articleId: id,
        revisionId: revision.id,
        formatKind: TLDR,
        task: TASK,
        status: 'running',
        requestedBy: ctx.user.id,
        startedAt: now,
        model,
        promptVersion: JEV_PROMPT_VERSION,
        inputFingerprint: revision.sentencesFingerprint,
        sentenceCount: input.sentences.length,
        boundMin: bounds.min,
        boundMax: bounds.max,
      })
      .returning();
    return inserted;
  });

  // 3. The model call happens outside any transaction.
  let result: JevResult;
  try {
    const site = await getCurrentSite();
    result = await runJev(input, {
      llm: depsOverride?.llm ?? getLlmClient(),
      model,
      now: () => performance.now(),
      timeoutMs: config.jevTimeoutMs,
      siteName: site.brandName,
    });
  } catch (error) {
    await db
      .update(aiGeneration)
      .set({ status: 'failed', finishedAt: new Date(), errorCode: 'INTERNAL', errorMessage: 'Unexpected error while running Jev.' })
      .where(and(eq(aiGeneration.id, generation.id), eq(aiGeneration.siteId, ctx.siteId)));
    throw error;
  }

  const usage = {
    attempts: result.attempts,
    promptTokens: result.usage.promptTokens,
    completionTokens: result.usage.completionTokens,
    totalTokens: result.usage.totalTokens,
    costUsd: result.usage.costUsd,
    latencyMs: result.latencyMs,
    providerGenerationIds: result.usage.providerGenerationIds,
    finishedAt: new Date(),
  };

  // 4a. Failure: record it; the existing draft deck is untouched.
  if (!result.ok) {
    const [failed] = await db
      .update(aiGeneration)
      .set({
        ...usage,
        status: 'failed',
        errorCode: result.error.code,
        errorMessage: result.error.message,
        output: result.rawOutputs.length > 0 ? { rawOutputs: result.rawOutputs } : null,
      })
      .where(and(eq(aiGeneration.id, generation.id), eq(aiGeneration.siteId, ctx.siteId)))
      .returning();
    const names = await userNames(ctx.siteId, [failed.requestedBy]);
    throw new ApiError(result.error.code, JEV_ERROR_STATUS[result.error.code], result.error.message, {
      generation: toGenerationDto(failed, names),
    });
  }

  // 4b. Success: record usage + picks, replace the draft deck with slides built from OUR sentences.
  const bySid = new Map(input.sentences.map((s) => [s.sid, s]));
  const payload: TldrPayload = {
    slides: result.picks.map((p) => ({ sid: p.sid, text: bySid.get(p.sid)!.text, source: 'jev', reason: p.reason })),
    generationId: generation.id,
  };
  let succeeded: AiGenerationRow | undefined;
  await db.transaction(async (tx) => {
    [succeeded] = await tx
      .update(aiGeneration)
      .set({
        ...usage,
        status: 'succeeded',
        output: { picks: result.picks.map((p) => ({ index: p.index, sid: p.sid, reason: p.reason })) },
      })
      .where(and(eq(aiGeneration.id, generation.id), eq(aiGeneration.siteId, ctx.siteId)))
      .returning();
    await upsertDraft(tx, ctx, id, { payload, revisionId: revision.id, fingerprint: revision.sentencesFingerprint });
  });

  const fresh = await findArticle(ctx.siteId, id);
  const names = await userNames(ctx.siteId, [succeeded!.requestedBy]);
  return { tldr: await buildTldrState(ctx.siteId, fresh ?? row), generation: toGenerationDto(succeeded!, names) };
}

async function upsertDraft(
  tx: Tx,
  ctx: ActorContext,
  articleId: string,
  draft: { payload: TldrPayload | null; revisionId: string | null; fingerprint: string | null },
): Promise<void> {
  const now = new Date();
  const values = {
    draftPayload: draft.payload,
    draftRevisionId: draft.revisionId,
    draftFingerprint: draft.fingerprint,
    draftUpdatedBy: ctx.user.id,
    draftUpdatedAt: now,
  };
  await tx
    .insert(articleFormat)
    .values({ siteId: ctx.siteId, articleId, kind: TLDR, ...values })
    .onConflictDoUpdate({ target: [articleFormat.articleId, articleFormat.kind], set: values, setWhere: eq(articleFormat.siteId, ctx.siteId) });
}

export async function saveDeck(ctx: ActorContext, id: string, body: SaveDeckBody): Promise<TldrStateDto> {
  await getDb().transaction(async (tx) => {
    const row = await lockArticle(tx, ctx.siteId, id);
    if (!row) throw notFound(id);
    if (row.currentRevisionId !== body.revisionId) throw conflict();
    const revision = await requireCurrentRevision(ctx.siteId, row, tx);
    const rendered = await renderRevision(revision);

    if (body.slides.length < TLDR_MIN_SLIDES || body.slides.length > TLDR_MAX_SLIDES) {
      throw new ApiError(
        'DECK_INVALID',
        422,
        body.slides.length === 0
          ? 'A deck needs at least one line — use “Clear deck” to remove it.'
          : `A deck can have at most ${TLDR_MAX_SLIDES} lines (got ${body.slides.length}).`,
        { sids: [] } satisfies DeckInvalidDetails,
      );
    }
    const bySid = new Map(rendered.sentences.map((s) => [s.sid, s]));
    const seen = new Set<string>();
    const bad: string[] = [];
    for (const slide of body.slides) {
      if (!bySid.has(slide.sid) || seen.has(slide.sid)) bad.push(slide.sid);
      seen.add(slide.sid);
    }
    if (bad.length > 0) {
      throw new ApiError(
        'DECK_INVALID',
        422,
        `Some deck lines aren't sentences of the current version (or appear twice): ${bad.length} line${bad.length === 1 ? '' : 's'}.`,
        { sids: [...new Set(bad)] } satisfies DeckInvalidDetails,
      );
    }

    const existing = readTldrPayload((await findFormatRow(ctx.siteId, id, TLDR, tx))?.draftPayload);
    const payload: TldrPayload = {
      slides: body.slides.map((s) => ({
        sid: s.sid,
        text: bySid.get(s.sid)!.text,
        source: s.source,
        reason: s.reason && s.reason.trim() !== '' ? s.reason.trim() : null,
      })),
      generationId: existing?.generationId ?? null,
    };
    await upsertDraft(tx, ctx, id, { payload, revisionId: revision.id, fingerprint: revision.sentencesFingerprint });
  });
  return getTldrState(ctx.siteId, id);
}

export async function clearDeck(ctx: ActorContext, id: string): Promise<TldrStateDto> {
  await getDb().transaction(async (tx) => {
    const row = await lockArticle(tx, ctx.siteId, id);
    if (!row) throw notFound(id);
    await tx
      .update(articleFormat)
      .set({ draftPayload: null, draftRevisionId: null, draftFingerprint: null, draftUpdatedBy: ctx.user.id, draftUpdatedAt: new Date() })
      .where(and(eq(articleFormat.siteId, ctx.siteId), eq(articleFormat.articleId, id), eq(articleFormat.kind, TLDR)));
  });
  return getTldrState(ctx.siteId, id);
}
