import 'server-only';

import { and, eq } from 'drizzle-orm';

import type { DeckInvalidDetails, DeckSlideDto, GenerationDto, SentenceDto, TldrStateDto } from '@/lib/api/dto';
import type { RenderedArticle } from '@/lib/content/types';

import { getConfig } from '../config';
import { getDb, type Executor } from '../db/client';
import { aiGeneration, articleFormat, type AiGenerationRow, type ArticleRow } from '../db/schema';
import { readTldrPayload, TLDR_MAX_SLIDES, TLDR_MIN_SLIDES, type TldrPayload } from '../formats/payload';
import { missingSlides, tldrAdapter } from '../formats/tldr';
import { GENERATION_STALE_MS, isGenerationActive } from '../formats/types';
import { ApiError } from '../http/api';
import { computeBounds } from '../jev/bounds';
import { buildState, guardInput, jevInputFromRendered } from '../jev/build-input';
import { JEV_PROMPT_VERSION } from '../jev/prompt';
import { runJev } from '../jev/run';
import type { JevErrorCode, JevResult } from '../jev/state';
import { getLlmClient, isLlmConfigured } from '../llm';
import type { LlmClient } from '../llm/types';
import {
  findArticle,
  findFormatRow,
  latestGeneration,
  latestSucceededGeneration,
  lockArticle,
  requireCurrentRevision,
  upsertFormatDraft,
  userNames,
} from './repo';
import type { SaveDeckBody } from './schemas';
import { notFound, type ActorContext } from './service';
import { iso, renderRevision, UNKNOWN_USER } from './views';

// TLDR (spec/architecture.md §3 "Generate", "Relevance in the editor", "Deck edit"): the editor's
// TLDR state, the generation row, the Jev call and the draft deck. Jev only returns a relevance
// score per sentence id we issued; every slide's text is taken from the server's own sentence list.
// Scores live only in ai_generation.output.scores; the editor reads the latest succeeded row.

const ABANDONED_CODE = 'GENERATION_ABANDONED';
const ABANDONED_MESSAGE = 'This generation never finished (the server may have restarted) — try again.';

const TLDR = 'tldr';
const TASK = 'tldr.rank';
/** Each stored raw response body is capped (spec/data.md → ai_generation.output). */
const RAW_OUTPUT_MAX_CHARS = 50_000;

/** HTTP status per Jev/LLM error code (spec/api.md → Error codes). */
const JEV_ERROR_STATUS: Record<JevErrorCode, number> = {
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

/** Whether Generate can run: false only in designer mode with no OpenRouter key (or a test LLM override). */
function jevAvailable(): boolean {
  return depsOverride?.llm !== undefined || isLlmConfigured();
}

export async function getTldrState(siteId: string, id: string): Promise<TldrStateDto> {
  const row = await findArticle(siteId, id);
  if (!row) throw notFound(id);
  return buildTldrState(siteId, row);
}

function draftOf(ctx: ActorContext, payload: TldrPayload | null, revisionId: string | null, fingerprint: string | null) {
  return { draftPayload: payload, draftRevisionId: revisionId, draftFingerprint: fingerprint, draftUpdatedBy: ctx.user.id, draftUpdatedAt: new Date() };
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

  // 0. Designer mode without a key: refuse before any row or call exists (LLM_NOT_CONFIGURED, 503).
  const llm = depsOverride?.llm ?? getLlmClient();

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
  const guard = guardInput(input, buildState(input));
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
    result = await runJev(input, {
      llm,
      model,
      now: () => performance.now(),
      timeoutMs: config.jevTimeoutMs,
    });
  } catch (error) {
    await db
      .update(aiGeneration)
      .set({ status: 'failed', finishedAt: new Date(), errorCode: 'INTERNAL', errorMessage: 'Unexpected error while running Jev.' })
      .where(and(eq(aiGeneration.id, generation.id), eq(aiGeneration.siteId, ctx.siteId)));
    throw error;
  }

  const usage = {
    attempts: result.batches, // decisions requests sent
    promptTokens: result.usage.inputTokens,
    completionTokens: result.usage.outputTokens,
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
        output: result.rawOutputs.length > 0 ? { rawOutputs: result.rawOutputs.map((r) => r.slice(0, RAW_OUTPUT_MAX_CHARS)) } : null,
      })
      .where(and(eq(aiGeneration.id, generation.id), eq(aiGeneration.siteId, ctx.siteId)))
      .returning();
    const names = await userNames(ctx.siteId, [failed.requestedBy]);
    throw new ApiError(result.error.code, JEV_ERROR_STATUS[result.error.code], result.error.message, {
      generation: toGenerationDto(failed, names),
    });
  }

  // 4b. Success: record usage + every score, replace the draft deck with the top k built from OUR
  // sentences (document order).
  const bySid = new Map(input.sentences.map((s) => [s.sid, s]));
  const payload: TldrPayload = {
    slides: result.selected.map((p) => ({ sid: p.sid, text: bySid.get(p.sid)!.text, source: 'jev' })),
    generationId: generation.id,
  };
  const output: RankOutput = {
    scores: result.scores.map(({ index, sid, relevance }) => ({ index, sid, relevance })),
    selected: result.selected.map((p) => p.sid),
    k: result.k,
    batches: result.batches,
  };
  let succeeded: AiGenerationRow | undefined;
  await db.transaction(async (tx) => {
    [succeeded] = await tx
      .update(aiGeneration)
      .set({
        ...usage,
        status: 'succeeded',
        output,
      })
      .where(and(eq(aiGeneration.id, generation.id), eq(aiGeneration.siteId, ctx.siteId)))
      .returning();
    await upsertFormatDraft(tx, ctx.siteId, id, TLDR, draftOf(ctx, payload, revision.id, revision.sentencesFingerprint));
  });

  const fresh = await findArticle(ctx.siteId, id);
  const names = await userNames(ctx.siteId, [succeeded!.requestedBy]);
  return { tldr: await buildTldrState(ctx.siteId, fresh ?? row), generation: toGenerationDto(succeeded!, names) };
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
      slides: body.slides.map((s) => ({ sid: s.sid, text: bySid.get(s.sid)!.text, source: s.source })),
      generationId: existing?.generationId ?? null,
    };
    await upsertFormatDraft(tx, ctx.siteId, id, TLDR, draftOf(ctx, payload, revision.id, revision.sentencesFingerprint));
  });
  return getTldrState(ctx.siteId, id);
}

export async function clearDeck(ctx: ActorContext, id: string): Promise<TldrStateDto> {
  await getDb().transaction(async (tx) => {
    const row = await lockArticle(tx, ctx.siteId, id);
    if (!row) throw notFound(id);
    await tx
      .update(articleFormat)
      .set(draftOf(ctx, null, null, null))
      .where(and(eq(articleFormat.siteId, ctx.siteId), eq(articleFormat.articleId, id), eq(articleFormat.kind, TLDR)));
  });
  return getTldrState(ctx.siteId, id);
}

// ---------------------------------------------------------------------------------------------
// TLDR state (GET …/tldr and every TLDR mutation's response)
// ---------------------------------------------------------------------------------------------

/** ai_generation.output of a succeeded Phase 8 run (spec/data.md). */
export interface RankOutput {
  scores: Array<{ index: number; sid: string; relevance: number }>;
  selected: string[];
  k: number;
  batches: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * sid → relevance from a generation's `output.scores`. Legacy (`{ picks: [{ index, sid, reason }] }`),
 * failed (`{ rawOutputs }`) and malformed outputs give an empty map; malformed entries are skipped.
 */
export function readScores(output: unknown): Map<string, number> {
  const scores = new Map<string, number>();
  const list = isRecord(output) ? output.scores : undefined;
  if (!Array.isArray(list)) return scores;
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const { sid, relevance } = entry;
    if (typeof sid !== 'string' || typeof relevance !== 'number' || !Number.isFinite(relevance) || relevance < 0 || relevance > 1) continue;
    if (!scores.has(sid)) scores.set(sid, relevance);
  }
  return scores;
}

/** The k selected sentences of a succeeded generation (document order); legacy picks get relevance null. */
function storedPicks(output: unknown): GenerationDto['picks'] {
  if (!isRecord(output)) return null;
  if (Array.isArray(output.selected) && Array.isArray(output.scores)) {
    const scores = readScores(output);
    const indexBySid = new Map<string, number>();
    for (const e of output.scores) if (isRecord(e) && typeof e.sid === 'string' && typeof e.index === 'number') indexBySid.set(e.sid, e.index);
    return output.selected
      .filter((sid): sid is string => typeof sid === 'string')
      .map((sid) => ({ index: indexBySid.get(sid) ?? -1, sid, relevance: scores.get(sid) ?? null }));
  }
  if (Array.isArray(output.picks)) {
    return output.picks
      .filter((p): p is { index: number; sid: string } => isRecord(p) && typeof p.sid === 'string' && typeof p.index === 'number')
      .map((p) => ({ index: p.index, sid: p.sid, relevance: null }));
  }
  return null;
}

function toGenerationDto(gen: AiGenerationRow, names: Map<string, string>, now: Date = new Date()): GenerationDto {
  const abandoned = gen.status === 'running' && !isGenerationActive(gen, now);
  return {
    id: gen.id,
    status: abandoned ? 'failed' : gen.status,
    model: gen.model,
    promptVersion: gen.promptVersion,
    requestedBy: names.get(gen.requestedBy) ?? UNKNOWN_USER,
    startedAt: gen.startedAt.toISOString(),
    finishedAt: iso(gen.finishedAt),
    latencyMs: gen.latencyMs,
    attempts: gen.attempts,
    sentenceCount: gen.sentenceCount,
    promptTokens: gen.promptTokens,
    completionTokens: gen.completionTokens,
    totalTokens: gen.totalTokens,
    costUsd: gen.costUsd === null ? null : Number(gen.costUsd),
    picks: gen.status === 'succeeded' ? storedPicks(gen.output) : null,
    errorCode: abandoned ? ABANDONED_CODE : gen.errorCode,
    errorMessage: abandoned ? ABANDONED_MESSAGE : gen.errorMessage,
  };
}

function toSentenceDtos(rendered: RenderedArticle, relevance: Map<string, number>): SentenceDto[] {
  const headingByPid = new Map(rendered.paragraphs.map((p) => [p.pid, p.headingPath]));
  return rendered.sentences.map((s) => ({
    sid: s.sid,
    index: s.index,
    pid: s.pid,
    text: s.text,
    words: s.words,
    headingPath: headingByPid.get(s.pid) ?? [],
    relevance: relevance.get(s.sid) ?? null,
  }));
}

async function buildTldrState(siteId: string, row: ArticleRow, now: Date = new Date(), db: Executor = getDb()): Promise<TldrStateDto> {
  const revision = await requireCurrentRevision(siteId, row, db);
  const [rendered, formatRow, gen, scored] = await Promise.all([
    renderRevision(revision),
    findFormatRow(siteId, row.id, TLDR, db),
    latestGeneration(siteId, row.id, TLDR, db),
    latestSucceededGeneration(siteId, row.id, TLDR, db),
  ]);
  // Relevance by sid from the latest SUCCEEDED generation (a later failed/running one keeps the scores).
  const relevance = readScores(scored?.output);
  const names = await userNames(siteId, [formatRow?.draftUpdatedBy, gen?.requestedBy], db);

  const draftPayload = readTldrPayload(formatRow?.draftPayload);
  let draft: TldrStateDto['draft'] = null;
  if (formatRow && draftPayload) {
    const missing = new Set(missingSlides(draftPayload.slides, rendered.sentences));
    draft = {
      slides: draftPayload.slides.map(
        (s): DeckSlideDto => ({
          sid: s.sid,
          text: s.text,
          source: s.source,
          relevance: relevance.get(s.sid) ?? null,
          missing: missing.has(s.sid),
        }),
      ),
      revisionId: formatRow.draftRevisionId ?? revision.id,
      updatedAt: (formatRow.draftUpdatedAt ?? formatRow.updatedAt).toISOString(),
      updatedBy: (formatRow.draftUpdatedBy && names.get(formatRow.draftUpdatedBy)) || UNKNOWN_USER,
    };
  }

  const publishedPayload = readTldrPayload(formatRow?.publishedPayload);
  const published: TldrStateDto['published'] =
    formatRow && publishedPayload && formatRow.publishedAt
      ? { slides: publishedPayload.slides.map((s) => ({ text: s.text })), publishedAt: formatRow.publishedAt.toISOString() }
      : null;

  return {
    status: tldrAdapter.computeStatus({ row: formatRow, currentRevision: revision, latestGeneration: gen, now }),
    bounds: rendered.sentences.length === 0 ? null : computeBounds(rendered.sentences),
    sentences: toSentenceDtos(rendered, relevance),
    draft,
    published,
    latestGeneration: gen ? toGenerationDto(gen, names, now) : null,
    jevAvailable: jevAvailable(),
  };
}
