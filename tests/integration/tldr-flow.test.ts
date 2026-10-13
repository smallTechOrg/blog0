// TLDR flow against real blog0_test.
//
// 1. "real Jev" suite — create → save → Generate (REAL OpenRouter call) → edit deck → publish →
//    public view model → text change ⇒ stale with no new generation row; wrong model slug ⇒
//    LLM_MODEL_NOT_FOUND. With no real key (and none required) it is SKIPPED as "PENDING KEY" — never
//    stubbed into a pass.
// 2. Hand-pick suite — every deck/publish/stale rule with writer-picked lines (no LLM at all).
// 3. "(fake transport)" suites — error-path/structure tests only: an OpenRouterDecisionsClient whose
//    fetch returns provider ERRORS (401 / incomplete answers) or blocks, to prove failure recording,
//    the untouched draft, hand-pick after failure, and the double-click guard. No fake success.
// Phase 8: Jev ranks every sentence; relevance is read from the latest succeeded generation by sid.
import { and, count, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PATCH as patchRoute } from '@/app/api/admin/articles/[id]/route';
import { DELETE as clearRoute, GET as tldrRoute, PUT as saveDeckRoute } from '@/app/api/admin/articles/[id]/tldr/route';
import { POST as generateRoute } from '@/app/api/admin/articles/[id]/tldr/generate/route';
import type {
  DeckInvalidDetails,
  GenerateTldrErrorDetails,
  GenerateTldrResponse,
  PublishBlockedDetails,
  TldrResponse,
  TldrStateDto,
  UpdateArticleResponse,
} from '@/lib/api/dto';
import { createArticle as serviceCreateArticle, type ActorContext } from '@/server/articles/service';
import { getTldrState, resetJevDepsForTests, saveDeck as serviceSaveDeck, setJevDepsForTests } from '@/server/articles/tldr';
import { Secret } from '@/server/config';
import { getDb } from '@/server/db/client';
import { aiGeneration, appUser, articleFormat, articleRevision, site } from '@/server/db/schema';
import { JEV_PROMPT_VERSION } from '@/server/jev/prompt';
import { resetLlmClientForTests } from '@/server/llm';
import { openRouterKeyStatus, PENDING_KEY_REASON, realKeyRequired } from '@/server/llm/key';
import { OpenRouterDecisionsClient } from '@/server/llm/openrouter';
import { getPublishedArticle } from '@/server/public/articles';
import { loadSeedPosts } from '@/server/seed/posts';
import { siteSeedFor } from '@/server/site/defaults';

import { actAs, call, createArticle, data, err, ORIGIN, publish } from '../helpers/api';
import { resetDb } from '../helpers/db';
import { captureLogs, type CapturedLogs } from '../helpers/logs';
import { loginAs, type TestLogin } from '../helpers/session';

// Real-key rule (spec/architecture.md → Conventions → Real-key tests).
// No real key: the real suite is SKIPPED (visible PENDING KEY reason) unless `realKeyRequired`
// (BLOG0_REQUIRE_REAL_KEY=1, or CI=true when that is unset) — then it is an explicit FAILURE naming the PENDING KEY reason — never a vague provider 401/LLM_AUTH.
const keyStatus = openRouterKeyStatus(process.env.BLOG0_OPENROUTER_API_KEY);
const pendingKey = keyStatus !== 'real';
const keyRequired = realKeyRequired(process.env);
if (pendingKey && !keyRequired) console.warn(`[tldr-flow] ${PENDING_KEY_REASON} (key ${keyStatus}); the real Generate suite is skipped.`);

describe.runIf(pendingKey && keyRequired)('TLDR real-key requirement (BLOG0_REQUIRE_REAL_KEY=1 / CI)', () => {
  it(`fails: ${PENDING_KEY_REASON} (a real key is required: BLOG0_REQUIRE_REAL_KEY=1 or CI=true)`, () => {
    throw new Error(`${PENDING_KEY_REASON} (key ${keyStatus}) — a real OpenRouter key is required (BLOG0_REQUIRE_REAL_KEY=1, or CI=true when unset); this is a failure, not a skip.`);
  });
});

const BODY = [
  '## Why decks',
  '',
  'The deck shows the strongest lines of the article in order. Each slide holds exactly one sentence from the text.',
  '',
  'Writers pick the lines by hand when the model is unavailable. That keeps publishing moving on a bad day.',
  '',
  '## How it works',
  '',
  'The server owns every word that appears on a slide. Nothing the model writes ever reaches a reader.',
  '',
  'A short one.',
  '',
  'Readers can open the deck from any article page. The published deck keeps serving until the next publish.',
].join('\n');

let writer: TestLogin;

async function save(id: string, body: Record<string, unknown>) {
  return data((await call<UpdateArticleResponse>(patchRoute, 'PATCH', `/api/admin/articles/${id}`, { body, id })).env);
}
async function tldr(id: string): Promise<TldrStateDto> {
  return data((await call<TldrStateDto>(tldrRoute, 'GET', `/api/admin/articles/${id}/tldr`, { id })).env);
}
async function putDeck(id: string, body: Record<string, unknown>) {
  return call<TldrResponse>(saveDeckRoute, 'PUT', `/api/admin/articles/${id}/tldr`, { body, id });
}
async function generate(id: string, revisionId: string) {
  return call<GenerateTldrResponse>(generateRoute, 'POST', `/api/admin/articles/${id}/tldr/generate`, { body: { revisionId }, id });
}
async function generationRows(articleId: string): Promise<number> {
  const [row] = await getDb().select({ n: count() }).from(aiGeneration).where(eq(aiGeneration.articleId, articleId));
  return Number(row.n);
}
async function publishedPayload(articleId: string): Promise<unknown> {
  const [row] = await getDb()
    .select({ p: articleFormat.publishedPayload })
    .from(articleFormat)
    .where(and(eq(articleFormat.articleId, articleId), eq(articleFormat.kind, 'tldr')));
  return row?.p ?? null;
}

/** Edits one sentence that occurs verbatim in the Markdown (so the edit really changes that sentence). */
function editSentence(bodyMd: string, text: string): string {
  expect(bodyMd.includes(text)).toBe(true);
  return bodyMd.replace(text, text.replace(/[.!?]?$/, ', or so we were told.'));
}

// ---------------------------------------------------------------------------------------------
// Fake transports for error-path/structure tests ONLY (they never return a successful selection).
// ---------------------------------------------------------------------------------------------

function fakeOpenRouter(fetchImpl: typeof fetch): OpenRouterDecisionsClient {
  return new OpenRouterDecisionsClient({
    apiKey: new Secret('fake-transport-key-not-real'),
    decisionsUrl: 'https://openrouter.invalid/api/alpha/decisions',
    referer: ORIGIN,
    fetch: fetchImpl,
    sleep: async () => {},
    retryDelaysMs: [],
  });
}

function http401Transport(counter: { calls: number }): typeof fetch {
  return (async () => {
    counter.calls += 1;
    return new Response(JSON.stringify({ error: { code: 401, message: 'No auth credentials found' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

/** A 200 decisions response that answers every question but the first, and one out of range (an ERROR path). */
function incompleteAnswersTransport(counter: { calls: number }): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    counter.calls += 1;
    const ids = Object.keys((JSON.parse(String(init?.body)) as { questions: Record<string, unknown> }).questions);
    const answers: Record<string, unknown> = {};
    ids.slice(1).forEach((id, i) => {
      answers[id] = { type: 'noul', noul: i === 0 ? 1.5 : 0.5 };
    });
    return new Response(
      JSON.stringify({ model: 'fake/transport', answers, usage: { input_tokens: 50, output_tokens: 5, cost: 0.0001 }, id: `fake-transport-${counter.calls}`, provider: 'fake-transport' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
}

beforeEach(async () => {
  await resetDb();
  resetJevDepsForTests();
  resetLlmClientForTests();
  writer = actAs(await loginAs({ displayName: 'Asha Writer' }));
});

afterEach(() => {
  resetJevDepsForTests();
});

// =============================================================================================
// 1. Real Jev (real OpenRouter key from .env)
// =============================================================================================

describe.skipIf(pendingKey)(pendingKey ? `real Jev Generate — ${PENDING_KEY_REASON}` : 'real Jev Generate', () => {
  let logs: CapturedLogs;
  beforeEach(() => {
    logs = captureLogs();
  });
  afterEach(() => {
    logs.stop();
  });

  it('create → save → generate (real call) → edit deck → publish → public view → stale after a text change with no new generation row', async () => {
    const post = loadSeedPosts().find((p) => p.slug === 'tech-company-first')!;
    const created = await createArticle({ title: post.title, dek: post.dek, topic: 'Perspectives', bodyMd: 'Placeholder body.' });
    const saved = await save(created.id, { baseRevisionId: created.currentRevision.id, bodyMd: post.bodyMd });
    expect(saved.revisionCreated).toBe(true);
    const revisionId = saved.article.currentRevision.id;

    // Generate — the real OpenRouter call.
    const gen = await generate(created.id, revisionId);
    expect(gen.status).toBe(200);
    const { tldr: state, generation } = data(gen.env);

    const sentences = new Map(state.sentences.map((s) => [s.sid, s]));
    const n = state.sentences.length;
    expect(state.status).toBe('ready');
    expect(state.bounds).not.toBeNull();
    // every eligible sentence carries Jev's score
    for (const s of state.sentences) {
      expect(s.relevance).toBeTypeOf('number');
      expect(s.relevance).toBeGreaterThanOrEqual(0);
      expect(s.relevance).toBeLessThanOrEqual(1);
    }
    const slides = state.draft!.slides;
    const k = state.bounds!.target;
    expect(slides).toHaveLength(k);
    const indices = slides.map((s) => sentences.get(s.sid)!.index);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    expect(new Set(indices).size).toBe(indices.length);
    for (const slide of slides) {
      expect(slide.source).toBe('jev');
      expect(slide.missing).toBe(false);
      expect(slide.text).toBe(sentences.get(slide.sid)!.text);
      expect(slide.relevance).toBe(sentences.get(slide.sid)!.relevance);
    }
    // the deck is the top k: its lowest score ≥ every other sentence's score
    const picked = new Set(slides.map((s) => s.sid));
    const minPicked = Math.min(...slides.map((s) => s.relevance!));
    const others = state.sentences.filter((s) => !picked.has(s.sid)).map((s) => s.relevance!);
    expect(minPicked).toBeGreaterThanOrEqual(Math.max(...others));
    expect(JSON.stringify(state)).not.toContain('"reason"');
    expect(generation).toMatchObject({
      status: 'succeeded',
      model: 'typesafe/jev-1.13',
      promptVersion: 'jev-rank-v1',
      requestedBy: 'Asha Writer',
      attempts: 1,
      sentenceCount: n,
    });
    expect(generation.promptTokens).toBeGreaterThan(0);
    expect(generation.totalTokens).toBe(generation.promptTokens! + (generation.completionTokens ?? 0));
    expect(generation.latencyMs).toBeGreaterThan(0);
    expect(generation.picks).toEqual(slides.map((s) => ({ index: sentences.get(s.sid)!.index, sid: s.sid, relevance: s.relevance })));
    if (generation.costUsd === null) expect(logs.find('llm.cost_missing').length).toBeGreaterThan(0);
    else expect(generation.costUsd).toBeGreaterThanOrEqual(0);
    const [row] = await getDb().select().from(aiGeneration).where(eq(aiGeneration.id, generation.id));
    expect(row).toMatchObject({ status: 'succeeded', revisionId, requestedBy: writer.user.id, promptVersion: 'jev-rank-v1', model: 'typesafe/jev-1.13', task: 'tldr.rank', attempts: 1, sentenceCount: n });
    expect(row.providerGenerationIds).toHaveLength(1);
    const output = row.output as { scores: Array<{ index: number; sid: string; relevance: number }>; selected: string[]; k: number; batches: number };
    expect(output.scores).toHaveLength(n);
    expect(output.scores.map((x) => x.sid)).toEqual(state.sentences.map((x) => x.sid));
    for (const x of output.scores) expect(sentences.get(x.sid)!.relevance).toBe(x.relevance);
    expect(output.selected).toEqual(slides.map((x) => x.sid));
    expect(output).toMatchObject({ k, batches: 1 });
    expect(logs.find('llm.call').some((l) => l.outcome === 'ok' && l.prompt_version === JEV_PROMPT_VERSION && l.model === 'typesafe/jev-1.13')).toBe(true);
    expect(logs.find('jev.run')[0]).toMatchObject({ outcome: 'ok', k, batches: 1, sentence_count: n });

    // Edit: drop the first line, add the best-scored unpicked line as a writer line, move it up one.
    const unpicked = [...state.sentences].filter((s) => !picked.has(s.sid)).sort((a, b) => b.relevance! - a.relevance!)[0];
    const edited = slides.slice(1).map((s) => ({ sid: s.sid, source: s.source as 'jev' | 'writer' }));
    edited.push({ sid: unpicked.sid, source: 'writer' });
    [edited[edited.length - 2], edited[edited.length - 1]] = [edited[edited.length - 1], edited[edited.length - 2]];
    const afterEdit = data((await putDeck(created.id, { revisionId, slides: edited })).env).tldr;
    expect(afterEdit.draft!.slides.map((s) => s.sid)).toEqual(edited.map((s) => s.sid));
    const reloaded = await tldr(created.id);
    expect(reloaded.draft!.slides.map((s) => s.sid)).toEqual(edited.map((s) => s.sid));
    const writerLine = reloaded.draft!.slides.find((s) => s.sid === unpicked.sid)!;
    expect(writerLine).toMatchObject({ source: 'writer', relevance: unpicked.relevance });

    // Publish → public view model shows exactly the edited deck, mixed disclosure.
    const published = data((await publish(created.id, revisionId)).env).article;
    const view = await getPublishedArticle(published.slug);
    const deckTexts = edited.map((s) => sentences.get(s.sid)!.text);
    expect(view!.deck!.slides.map((s) => s.text)).toEqual(deckTexts);
    expect(view!.deck!.disclosure).toBe('Lines selected by Jev (AI) and the editors, verbatim from the article.');

    // Text change → stale, flagged slide, publish blocked, no new generation, live deck unchanged.
    // Jev's picks vary run to run; a sentence whose source carries inline markup (bold, links)
    // is not verbatim in the Markdown, so edit the first deck line that is.
    const target = edited.map((s) => sentences.get(s.sid)!).find((s) => post.bodyMd.includes(s.text));
    expect(target, 'no deck line occurs verbatim in the Markdown').toBeDefined();
    if (!target) return;
    const changed = await save(created.id, { baseRevisionId: revisionId, bodyMd: editSentence(post.bodyMd, target.text) });
    const stale = await tldr(created.id);
    expect(stale.status).toBe('stale');
    // Scores survive by sid: unchanged sentences keep theirs; the edited sentence (and, because sids
    // derive from paragraph text, the rest of its paragraph) has none until the next Generate.
    const edited1 = stale.sentences.find((s) => s.text.includes('or so we were told'))!;
    expect(edited1.relevance).toBeNull();
    const kept = stale.sentences.filter((s) => sentences.has(s.sid));
    expect(kept.length).toBeGreaterThan(n / 2);
    for (const s of kept) expect(s.relevance).toBe(sentences.get(s.sid)!.relevance);
    for (const s of stale.sentences.filter((x) => !sentences.has(x.sid))) expect(s.relevance).toBeNull();
    expect(stale.latestGeneration!.id).toBe(generation.id);
    expect(stale.draft!.slides.find((s) => s.sid === target.sid)!.missing).toBe(true);
    const blocked = await publish(created.id, changed.article.currentRevision.id);
    expect(blocked.status).toBe(422);
    expect((err(blocked.env).details as PublishBlockedDetails).reasons).toContainEqual(
      // sentence ids derive from paragraph text, so other deck lines in the same paragraph go stale too
      expect.objectContaining({ code: 'TLDR_DECK_STALE', sids: expect.arrayContaining([target.sid]) }),
    );
    expect(await generationRows(created.id)).toBe(1);
    expect((await getPublishedArticle(published.slug))!.deck!.slides.map((s) => s.text)).toEqual(deckTexts);
  });

  it('a wrong model slug (real call) returns LLM_MODEL_NOT_FOUND, records a failed row and leaves the draft deck unchanged', async () => {
    const created = await createArticle({ title: 'Wrong model', topic: 'Analysis', bodyMd: BODY });
    const revisionId = created.currentRevision.id;
    const before = await tldr(created.id);
    const deck = [{ sid: before.sentences[0].sid, source: 'writer' as const }];
    await putDeck(created.id, { revisionId, slides: deck });
    setJevDepsForTests({ model: 'typesafe/does-not-exist' });

    const { status, env } = await generate(created.id, revisionId);

    expect(status).toBe(502);
    const e = err(env);
    expect(e.code).toBe('LLM_MODEL_NOT_FOUND');
    expect(e.message).toBe("Model 'typesafe/does-not-exist' isn't available as a decisions model — set BLOG0_JEV_MODEL (default typesafe/jev-1.13).");
    expect((e.details as GenerateTldrErrorDetails).generation).toMatchObject({ status: 'failed', errorCode: 'LLM_MODEL_NOT_FOUND', picks: null, attempts: 1 });
    const after = await tldr(created.id);
    expect(after.draft!.slides.map((s) => s.sid)).toEqual([deck[0].sid]);
    const [row] = await getDb().select().from(aiGeneration).where(eq(aiGeneration.articleId, created.id));
    expect(row.status).toBe('failed');
  });
});

// =============================================================================================
// 2. Hand-picked decks, publish rules and staleness (no LLM)
// =============================================================================================

describe('hand-picked deck lifecycle', () => {
  it('starts missing with eligible sentences and bounds, and no deck', async () => {
    const created = await createArticle({ title: 'Deck test', topic: 'Analysis', bodyMd: BODY });

    const state = await tldr(created.id);

    expect(state.status).toBe('missing');
    expect(state.sentences).toHaveLength(8);
    expect(state.sentences.map((s) => s.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(state.sentences.every((s) => s.words >= 5)).toBe(true);
    expect(state.sentences.some((s) => s.text === 'A short one.')).toBe(false);
    expect(state.sentences[4].headingPath).toEqual(['How it works']);
    expect(state.bounds).toEqual({ min: 4, max: 5, target: 4 });
    expect(state.draft).toBeNull();
    expect(state.published).toBeNull();
    expect(state.latestGeneration).toBeNull();
  });

  it('saves a reordered writer deck with server-resolved text, which survives a reload, then publishes it', async () => {
    const created = await createArticle({ title: 'Ordered', topic: 'Analysis', bodyMd: BODY });
    const { sentences } = await tldr(created.id);
    const slides = [
      { sid: sentences[6].sid, source: 'writer', reason: 'Closing line' },
      { sid: sentences[0].sid, source: 'writer' },
      { sid: sentences[3].sid, source: 'writer', reason: null },
    ];

    const saved = data((await putDeck(created.id, { revisionId: created.currentRevision.id, slides })).env).tldr;
    const reloaded = await tldr(created.id);
    const published = data((await publish(created.id, created.currentRevision.id)).env).article;
    const view = await getPublishedArticle(published.slug);
    const afterPublish = await tldr(created.id);

    expect(saved.status).toBe('ready');
    // A legacy `reason` key in the PUT body is stripped, not refused; no generation → no relevance.
    expect(reloaded.draft!.slides).toEqual([
      { sid: sentences[6].sid, text: sentences[6].text, source: 'writer', relevance: null, missing: false },
      { sid: sentences[0].sid, text: sentences[0].text, source: 'writer', relevance: null, missing: false },
      { sid: sentences[3].sid, text: sentences[3].text, source: 'writer', relevance: null, missing: false },
    ]);
    expect(reloaded.sentences.every((s) => s.relevance === null)).toBe(true);
    const [fmt] = await getDb().select().from(articleFormat).where(eq(articleFormat.articleId, created.id));
    expect(JSON.stringify(fmt.draftPayload)).not.toContain('"reason"');
    expect(reloaded.draft!.revisionId).toBe(created.currentRevision.id);
    expect(reloaded.draft!.updatedBy).toBe('Asha Writer');
    expect(published.formats.find((f) => f.kind === 'tldr')).toEqual({ kind: 'tldr', status: 'ready', published: true, hasUnpublishedChanges: false });
    expect(view!.deck!.slides.map((s) => s.text)).toEqual([sentences[6].text, sentences[0].text, sentences[3].text]);
    expect(view!.deck!.disclosure).toBe('Lines selected by the editors, verbatim from the article.');
    expect(view!.deck!.shareUrl).toBe(`${ORIGIN}/p/ordered/tldr`);
    expect(afterPublish.published!.slides.map((s) => s.text)).toEqual([sentences[6].text, sentences[0].text, sentences[3].text]);
    expect(await generationRows(created.id)).toBe(0);
  });

  it('reads a pre-Phase-8 deck (slides with reasons) and legacy generation: relevance null, then saves and publishes it', async () => {
    const created = await createArticle({ title: 'Legacy deck', topic: 'Analysis', bodyMd: BODY });
    const revisionId = created.currentRevision.id;
    const { sentences } = await tldr(created.id);
    const db = getDb();
    const [legacyGen] = await db
      .insert(aiGeneration)
      .values({
        siteId: writer.user.siteId,
        articleId: created.id,
        revisionId,
        formatKind: 'tldr',
        task: 'tldr.select',
        status: 'succeeded',
        requestedBy: writer.user.id,
        startedAt: new Date(Date.now() - 60_000),
        finishedAt: new Date(Date.now() - 59_000),
        model: 'google/gemini-2.5-flash',
        promptVersion: 'jev-select-v1',
        inputFingerprint: 'x',
        sentenceCount: 8,
        boundMin: 4,
        boundMax: 5,
        attempts: 1,
        output: { picks: [0, 2].map((i) => ({ index: i, sid: sentences[i].sid, reason: 'States the thesis' })) },
      })
      .returning();
    await db.insert(articleFormat).values({
      siteId: writer.user.siteId,
      articleId: created.id,
      kind: 'tldr',
      draftPayload: {
        slides: [
          { sid: sentences[0].sid, text: sentences[0].text, source: 'jev', reason: 'States the thesis' },
          { sid: sentences[2].sid, text: sentences[2].text, source: 'writer', reason: null },
        ],
        generationId: legacyGen.id,
      },
      draftRevisionId: revisionId,
      draftFingerprint: (await db.select().from(articleRevision).where(eq(articleRevision.id, revisionId)))[0].sentencesFingerprint,
      draftUpdatedBy: writer.user.id,
      draftUpdatedAt: new Date(),
    });

    const state = await tldr(created.id);

    expect(state.status).toBe('ready');
    expect(state.draft!.slides).toEqual([
      { sid: sentences[0].sid, text: sentences[0].text, source: 'jev', relevance: null, missing: false },
      { sid: sentences[2].sid, text: sentences[2].text, source: 'writer', relevance: null, missing: false },
    ]);
    expect(state.sentences.every((s) => s.relevance === null)).toBe(true);
    expect(state.latestGeneration).toMatchObject({ id: legacyGen.id, promptVersion: 'jev-select-v1', sentenceCount: 8 });
    expect(state.latestGeneration!.picks).toEqual([
      { index: 0, sid: sentences[0].sid, relevance: null },
      { index: 2, sid: sentences[2].sid, relevance: null },
    ]);
    expect(JSON.stringify(state)).not.toContain('"reason"');

    const saved = await putDeck(created.id, { revisionId, slides: state.draft!.slides.map((s) => ({ sid: s.sid, source: s.source, reason: 'legacy client' })) });
    expect(saved.status).toBe(200);
    const published = await publish(created.id, revisionId);
    expect(published.status).toBe(200);
    expect((await getPublishedArticle('legacy-deck'))!.deck!.slides.map((s) => s.text)).toEqual([sentences[0].text, sentences[2].text]);
  });

  it('reads relevance from the latest SUCCEEDED generation by sid (a later failed run keeps the scores)', async () => {
    const created = await createArticle({ title: 'Scores', topic: 'Analysis', bodyMd: BODY });
    const revisionId = created.currentRevision.id;
    const { sentences } = await tldr(created.id);
    const base = {
      siteId: writer.user.siteId,
      articleId: created.id,
      revisionId,
      formatKind: 'tldr',
      task: 'tldr.rank',
      requestedBy: writer.user.id,
      model: 'typesafe/jev-1.13',
      promptVersion: 'jev-rank-v1',
      inputFingerprint: 'x',
      sentenceCount: sentences.length,
      boundMin: 4,
      boundMax: 5,
      attempts: 1,
    };
    const scoresOf = (f: (i: number) => number) => sentences.map((s, i) => ({ index: i, sid: s.sid, relevance: f(i) }));
    await getDb().insert(aiGeneration).values([
      { ...base, status: 'succeeded', startedAt: new Date(Date.now() - 300_000), output: { scores: scoresOf(() => 0.1), selected: [], k: 4, batches: 1 } },
      { ...base, status: 'succeeded', startedAt: new Date(Date.now() - 200_000), output: { scores: scoresOf((i) => i / 10), selected: [sentences[7].sid, sentences[6].sid], k: 4, batches: 1 } },
      { ...base, status: 'failed', startedAt: new Date(Date.now() - 100_000), errorCode: 'LLM_INVALID_OUTPUT', output: { rawOutputs: ['{}'] } },
    ]);

    const state = await tldr(created.id);

    expect(state.sentences.map((s) => s.relevance)).toEqual(sentences.map((_, i) => i / 10));
    expect(state.latestGeneration).toMatchObject({ status: 'failed', picks: null, errorCode: 'LLM_INVALID_OUTPUT' });
  });

  it('rejects unknown, duplicate, empty and 13-slide decks with 422 DECK_INVALID listing the bad sids', async () => {
    const created = await createArticle({ title: 'Invalid decks', bodyMd: `${BODY}\n\n${Array.from({ length: 10 }, (_, i) => `Extra sentence number ${i} has enough words.`).join('\n\n')}` });
    const revisionId = created.currentRevision.id;
    const { sentences } = await tldr(created.id);

    const unknown = await putDeck(created.id, { revisionId, slides: [{ sid: sentences[0].sid, source: 'writer' }, { sid: 'p-deadbeef-s0', source: 'writer' }] });
    const duplicate = await putDeck(created.id, { revisionId, slides: [{ sid: sentences[1].sid, source: 'writer' }, { sid: sentences[1].sid, source: 'jev' }] });
    const empty = await putDeck(created.id, { revisionId, slides: [] });
    const thirteen = await putDeck(created.id, { revisionId, slides: sentences.slice(0, 13).map((s) => ({ sid: s.sid, source: 'writer' })) });
    const twelve = await putDeck(created.id, { revisionId, slides: sentences.slice(0, 12).map((s) => ({ sid: s.sid, source: 'writer' })) });

    expect(sentences.length).toBeGreaterThanOrEqual(13);
    expect(unknown.status).toBe(422);
    expect(err(unknown.env).code).toBe('DECK_INVALID');
    expect((err(unknown.env).details as DeckInvalidDetails).sids).toEqual(['p-deadbeef-s0']);
    expect((err(duplicate.env).details as DeckInvalidDetails).sids).toEqual([sentences[1].sid]);
    expect(empty.status).toBe(422);
    expect(err(empty.env).code).toBe('DECK_INVALID');
    expect(thirteen.status).toBe(422);
    expect(twelve.status).toBe(200);
    expect((await tldr(created.id)).draft!.slides).toHaveLength(12);
  });

  it('refuses a deck save against a non-current revision with 409 CONFLICT', async () => {
    const created = await createArticle({ title: 'Conflict deck', bodyMd: BODY });
    const { sentences } = await tldr(created.id);
    await save(created.id, { baseRevisionId: created.currentRevision.id, bodyMd: `${BODY}\n\nAnother paragraph with plenty of words.` });

    const { status, env } = await putDeck(created.id, { revisionId: created.currentRevision.id, slides: [{ sid: sentences[0].sid, source: 'writer' }] });

    expect(status).toBe(409);
    expect(err(env).code).toBe('CONFLICT');
    expect((await tldr(created.id)).draft).toBeNull();
  });

  it('keeps TLDR ready after a heading-only edit', async () => {
    const created = await createArticle({ title: 'Headings', bodyMd: BODY });
    const { sentences } = await tldr(created.id);
    await putDeck(created.id, { revisionId: created.currentRevision.id, slides: [{ sid: sentences[0].sid, source: 'writer' }] });

    const saved = await save(created.id, { baseRevisionId: created.currentRevision.id, bodyMd: BODY.replace('## How it works', '## How it really works') });
    const state = await tldr(created.id);

    expect(saved.revisionCreated).toBe(true);
    expect(state.status).toBe('ready');
    expect(state.sentences[4].headingPath).toEqual(['How it really works']);
  });

  it('marks the deck stale after a sentence edit, blocks publish, keeps the live deck, creates no generation, and recovers after a fix', async () => {
    const created = await createArticle({ title: 'Stale flow', topic: 'Analysis', bodyMd: BODY });
    const { sentences } = await tldr(created.id);
    const deck = [sentences[0], sentences[2], sentences[7]].map((s) => ({ sid: s.sid, source: 'writer' as const }));
    await putDeck(created.id, { revisionId: created.currentRevision.id, slides: deck });
    const first = data((await publish(created.id, created.currentRevision.id)).env).article;
    const liveTexts = [sentences[0].text, sentences[2].text, sentences[7].text];

    const changed = await save(created.id, { baseRevisionId: first.currentRevision.id, bodyMd: editSentence(BODY, sentences[2].text) });
    const stale = await tldr(created.id);
    const blocked = await publish(created.id, changed.article.currentRevision.id);
    const liveView = await getPublishedArticle(first.slug);

    expect(stale.status).toBe('stale');
    expect(stale.draft!.slides.map((s) => s.missing)).toEqual([false, true, false]);
    expect(changed.article.formats.find((f) => f.kind === 'tldr')!.status).toBe('stale');
    expect(blocked.status).toBe(422);
    expect((err(blocked.env).details as PublishBlockedDetails).reasons).toEqual([
      expect.objectContaining({ code: 'TLDR_DECK_STALE', sids: [sentences[2].sid] }),
    ]);
    expect(liveView!.deck!.slides.map((s) => s.text)).toEqual(liveTexts);
    expect(liveView!.blocks).toEqual((await getPublishedArticle(first.slug))!.blocks);
    expect(await generationRows(created.id)).toBe(0);

    // Fix: replace the vanished line with a current sentence, then Publish changes.
    const current = (await tldr(created.id)).sentences;
    const fixed = [sentences[0].sid, current.find((s) => s.text.includes('or so we were told'))!.sid, sentences[7].sid];
    const ready = data((await putDeck(created.id, { revisionId: changed.article.currentRevision.id, slides: fixed.map((sid) => ({ sid, source: 'writer' })) })).env).tldr;
    const republished = await publish(created.id, changed.article.currentRevision.id);
    const newView = await getPublishedArticle(first.slug);

    expect(ready.status).toBe('ready');
    expect(republished.status).toBe(200);
    expect(newView!.deck!.slides[1].text).toContain('or so we were told');
    expect(await generationRows(created.id)).toBe(0);
  });

  it('clears the draft deck with DELETE while the published deck keeps serving', async () => {
    const created = await createArticle({ title: 'Clear deck', topic: 'Analysis', bodyMd: BODY });
    const { sentences } = await tldr(created.id);
    await putDeck(created.id, { revisionId: created.currentRevision.id, slides: [{ sid: sentences[1].sid, source: 'writer' }] });
    await publish(created.id, created.currentRevision.id);

    const cleared = data((await call<TldrResponse>(clearRoute, 'DELETE', `/api/admin/articles/${created.id}/tldr`, { id: created.id })).env).tldr;
    const view = await getPublishedArticle('clear-deck');

    expect(cleared.status).toBe('missing');
    expect(cleared.draft).toBeNull();
    expect(cleared.published!.slides).toEqual([{ text: sentences[1].text }]);
    expect(view!.deck!.slides).toEqual([{ text: sentences[1].text }]);
    expect(await publishedPayload(created.id)).not.toBeNull();
  });

  it('returns 422 JEV_NO_SENTENCES with no generation row and no model call for an article without eligible sentences', async () => {
    const counter = { calls: 0 };
    setJevDepsForTests({ llm: fakeOpenRouter(http401Transport(counter)) });
    const created = await createArticle({ title: 'Tiny', bodyMd: 'Too short.\n\nAlso short.' });

    const { status, env } = await generate(created.id, created.currentRevision.id);
    const state = await tldr(created.id);

    expect(status).toBe(422);
    expect(err(env).code).toBe('JEV_NO_SENTENCES');
    expect(counter.calls).toBe(0);
    expect(await generationRows(created.id)).toBe(0);
    expect(state.bounds).toBeNull();
    expect(state.sentences).toEqual([]);
  });

  it('refuses Generate for a non-current revision with 409 CONFLICT and creates no row', async () => {
    const counter = { calls: 0 };
    setJevDepsForTests({ llm: fakeOpenRouter(http401Transport(counter)) });
    const created = await createArticle({ title: 'Old', bodyMd: BODY });
    await save(created.id, { baseRevisionId: created.currentRevision.id, bodyMd: `${BODY}\n\nOne more paragraph of words here.` });

    const { status, env } = await generate(created.id, created.currentRevision.id);

    expect(status).toBe(409);
    expect(err(env).code).toBe('CONFLICT');
    expect(counter.calls).toBe(0);
    expect(await generationRows(created.id)).toBe(0);
  });
});

// =============================================================================================
// 3. Error paths with a fake transport (provider errors only — never a fake success)
// =============================================================================================

describe('Generate error paths (fake transport)', () => {
  it('records a failed generation when the provider rejects the call, leaves the draft deck untouched, and still allows hand-picking (fake transport: HTTP 401)', async () => {
    const counter = { calls: 0 };
    setJevDepsForTests({ llm: fakeOpenRouter(http401Transport(counter)) });
    const created = await createArticle({ title: 'Jev down', topic: 'Analysis', bodyMd: BODY });
    const revisionId = created.currentRevision.id;
    const { sentences } = await tldr(created.id);
    await putDeck(created.id, { revisionId, slides: [{ sid: sentences[5].sid, source: 'writer' }] });

    const { status, env } = await generate(created.id, revisionId);

    expect(status).toBe(502);
    const e = err(env);
    expect(e.code).toBe('LLM_AUTH');
    expect(e.message).toContain('BLOG0_OPENROUTER_API_KEY');
    const failed = (e.details as GenerateTldrErrorDetails).generation;
    expect(failed).toMatchObject({ status: 'failed', errorCode: 'LLM_AUTH', attempts: 1, requestedBy: 'Asha Writer', promptVersion: JEV_PROMPT_VERSION, picks: null });
    expect(failed.finishedAt).not.toBeNull();
    expect(counter.calls).toBe(1);
    const afterFail = await tldr(created.id);
    expect(afterFail.draft!.slides.map((s) => s.sid)).toEqual([sentences[5].sid]);
    expect(afterFail.status).toBe('ready');
    expect(afterFail.latestGeneration).toMatchObject({ id: failed.id, status: 'failed', errorCode: 'LLM_AUTH' });
    const [row] = await getDb().select().from(aiGeneration).where(eq(aiGeneration.id, failed.id));
    expect(row).toMatchObject({ status: 'failed', errorCode: 'LLM_AUTH', revisionId, sentenceCount: 8, boundMin: 4, boundMax: 5 });

    // Hand-pick fallback: build the deck manually and publish.
    const handPicked = data((await putDeck(created.id, { revisionId, slides: [0, 3, 6].map((i) => ({ sid: sentences[i].sid, source: 'writer' })) })).env).tldr;
    const published = await publish(created.id, revisionId);
    expect(handPicked.status).toBe('ready');
    expect(published.status).toBe(200);
    expect((await getPublishedArticle('jev-down'))!.deck!.slides).toHaveLength(3);
  });

  it('shows TLDR failed when Jev fails and no draft exists (fake transport: HTTP 401)', async () => {
    setJevDepsForTests({ llm: fakeOpenRouter(http401Transport({ calls: 0 })) });
    const created = await createArticle({ title: 'No draft', bodyMd: BODY });

    await generate(created.id, created.currentRevision.id);
    const state = await tldr(created.id);

    expect(state.status).toBe('failed');
    expect(state.draft).toBeNull();
  });

  it('returns LLM_INVALID_OUTPUT after ONE request when answers are missing/out of range, storing the raw body and usage (fake transport: incomplete answers)', async () => {
    const counter = { calls: 0 };
    setJevDepsForTests({ llm: fakeOpenRouter(incompleteAnswersTransport(counter)) });
    const created = await createArticle({ title: 'Garbage', bodyMd: BODY });
    const { sentences } = await tldr(created.id);
    await putDeck(created.id, { revisionId: created.currentRevision.id, slides: [{ sid: sentences[1].sid, source: 'writer' }] });

    const { status, env } = await generate(created.id, created.currentRevision.id);

    expect(status).toBe(502);
    expect(err(env)).toMatchObject({
      code: 'LLM_INVALID_OUTPUT',
      message: "Jev didn't score every sentence (2 of 8 missing or invalid) — try again, or pick lines yourself.",
    });
    expect(counter.calls).toBe(1);
    const [row] = await getDb().select().from(aiGeneration).where(eq(aiGeneration.articleId, created.id));
    expect(row).toMatchObject({ status: 'failed', errorCode: 'LLM_INVALID_OUTPUT', attempts: 1, totalTokens: 55, promptTokens: 50, completionTokens: 5, task: 'tldr.rank' });
    expect(row.costUsd).toBeCloseTo(0.0001, 6);
    const raw = (row.output as { rawOutputs: string[] }).rawOutputs;
    expect(raw).toHaveLength(1);
    expect(JSON.parse(raw[0])).toMatchObject({ provider: 'fake-transport' });
    const after = await tldr(created.id);
    expect(after.draft!.slides.map((s) => s.sid)).toEqual([sentences[1].sid]);
    expect(after.sentences.every((s) => s.relevance === null)).toBe(true);
  });

  it('refuses a second Generate while the first is running with 409 GENERATION_IN_PROGRESS and creates exactly one row (fake transport: blocked then HTTP 401)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const counter = { calls: 0 };
    const blocking: typeof fetch = (async (...args: Parameters<typeof fetch>) => {
      entered();
      await gate;
      return http401Transport(counter)(...args);
    }) as typeof fetch;
    setJevDepsForTests({ llm: fakeOpenRouter(blocking) });
    const created = await createArticle({ title: 'Double click', bodyMd: BODY });
    const revisionId = created.currentRevision.id;

    const first = generate(created.id, revisionId);
    await started;
    const second = await generate(created.id, revisionId);
    const during = await tldr(created.id);
    release();
    const firstResult = await first;

    expect(second.status).toBe(409);
    expect(err(second.env).code).toBe('GENERATION_IN_PROGRESS');
    expect(during.status).toBe('generating');
    expect(during.latestGeneration!.status).toBe('running');
    expect(err(firstResult.env).code).toBe('LLM_AUTH');
    expect(counter.calls).toBe(1);
    expect(await generationRows(created.id)).toBe(1);
  });

  it('serialises two simultaneous clicks through the article row lock — never two runs at once (fake transport: HTTP 401)', async () => {
    const counter = { calls: 0 };
    setJevDepsForTests({ llm: fakeOpenRouter(http401Transport(counter)) });
    const created = await createArticle({ title: 'Simultaneous', bodyMd: BODY });

    const results = await Promise.all([generate(created.id, created.currentRevision.id), generate(created.id, created.currentRevision.id)]);
    const codes = results.map((r) => err(r.env).code).sort();

    // Either the second click hit the running row (409) or ran after the first finished (both 502).
    const rows = await generationRows(created.id);
    if (codes.includes('GENERATION_IN_PROGRESS')) expect(rows).toBe(1);
    else expect(rows).toBe(2);
    expect(counter.calls).toBe(rows);
  });

  it('treats a running generation older than 3 minutes as abandoned: reported failed and no longer blocking (fake transport: HTTP 401)', async () => {
    setJevDepsForTests({ llm: fakeOpenRouter(http401Transport({ calls: 0 })) });
    const created = await createArticle({ title: 'Abandoned', bodyMd: BODY });
    await getDb().insert(aiGeneration).values({
      siteId: writer.user.siteId,
      articleId: created.id,
      revisionId: created.currentRevision.id,
      formatKind: 'tldr',
      task: 'tldr.select',
      status: 'running',
      requestedBy: writer.user.id,
      startedAt: new Date(Date.now() - 4 * 60 * 1000),
      model: 'test/model',
      promptVersion: JEV_PROMPT_VERSION,
      inputFingerprint: 'x',
      sentenceCount: 8,
      boundMin: 4,
      boundMax: 5,
    });

    const before = await tldr(created.id);
    const { env } = await generate(created.id, created.currentRevision.id);

    expect(before.status).toBe('failed');
    expect(before.latestGeneration).toMatchObject({ status: 'failed', errorCode: 'GENERATION_ABANDONED' });
    expect(err(env).code).toBe('LLM_AUTH');
    expect(await generationRows(created.id)).toBe(2);
  });
});

// =============================================================================================
// 4. Tenant isolation (spec/architecture.md §6: every query filters by the current site id)
// =============================================================================================

describe('TLDR cross-site isolation (fake transport: HTTP 401)', () => {
  it('deck read/save/clear/generate against another site\'s article id return NOT_FOUND, write nothing and never call the model', async () => {
    const db = getDb();
    const [other] = await db.insert(site).values(siteSeedFor('other-site')).returning({ id: site.id });
    const [otherUser] = await db
      .insert(appUser)
      .values({ siteId: other.id, email: 'other@example.test', displayName: 'Other Writer', passwordHash: '$test-helper$not-a-real-hash' })
      .returning({ id: appUser.id, email: appUser.email, displayName: appUser.displayName, siteId: appUser.siteId });
    const otherCtx: ActorContext = { siteId: other.id, user: otherUser };
    const foreign = await serviceCreateArticle(otherCtx, { title: 'Other site deck', bodyMd: BODY });
    const revisionId = foreign.currentRevision.id;
    const sid = (await getTldrState(otherCtx.siteId, foreign.id)).sentences[0].sid;
    await serviceSaveDeck(otherCtx, foreign.id, { revisionId, slides: [{ sid, source: 'writer' }] });
    const formatBefore = await db.select().from(articleFormat).where(eq(articleFormat.articleId, foreign.id));
    const counter = { calls: 0 };
    setJevDepsForTests({ llm: fakeOpenRouter(http401Transport(counter)) });

    const results = [
      await call(tldrRoute, 'GET', `/api/admin/articles/${foreign.id}/tldr`, { id: foreign.id }),
      await putDeck(foreign.id, { revisionId, slides: [] }),
      await call(clearRoute, 'DELETE', `/api/admin/articles/${foreign.id}/tldr`, { id: foreign.id }),
      await generate(foreign.id, revisionId),
    ];

    for (const r of results) {
      expect(r.status).toBe(404);
      expect(err(r.env).code).toBe('NOT_FOUND');
    }
    expect(counter.calls).toBe(0);
    expect(await generationRows(foreign.id)).toBe(0);
    expect(await db.select().from(articleFormat).where(eq(articleFormat.articleId, foreign.id))).toEqual(formatBefore);
    expect(formatBefore).toHaveLength(1);
    expect((formatBefore[0].draftPayload as { slides: { sid: string }[] }).slides.map((s) => s.sid)).toEqual([sid]);
  });
});
