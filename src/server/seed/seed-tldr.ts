import 'server-only';

import { randomUUID } from 'node:crypto';

import { and, eq, inArray, isNull } from 'drizzle-orm';

import { publishArticle, type ActorContext } from '../articles/service';
import { generateTldr, saveDeck } from '../articles/tldr';
import { renderRevision } from '../articles/views';
import type { Db } from '../db/client';
import { aiGeneration, appUser, article, articleFormat, articleRevision } from '../db/schema';
import { readTldrPayload } from '../formats/payload';
import { ApiError } from '../http/api';
import { isLlmConfigured } from '../llm';
import { log } from '../log';

import { DECKS_DIR, loadDeckFixture, matchFixtureLines, writeDeckFixture } from './decks';
import { SEED_POSTS } from './posts';

// `pnpm seed:tldr` (spec/data.md → Seed data; capability reader-site → Seeding): one published
// TLDR deck per seeded post that has none.
//   - source 'jev'     → the normal Generate path (generateTldr: ai_generation row, cost, prompt
//                        version — exactly a writer's click), then the normal Publish
//                        (publishArticle: validates the deck, publishes draft → published).
//   - source 'fixture' → src/server/seed/decks/<slug>.json, lines matched by exact text to the
//                        published revision's eligible sentences (unmatched → warning, dropped),
//                        saved through saveDeck as `source: 'writer'` (disclosure "Lines selected
//                        by the editors…"), then publishArticle. 0 AI calls.
//   - source 'auto'    → 'jev' when a real OpenRouter key is configured, else 'fixture'.
// Idempotent: a post whose deck is already published is never touched. Never runs per view.
//
// The services it reuses read the app's handle (getDb()), so `db` MUST be that handle (scripts:
// initDb(); designer setup: initDb(); tests: getDb()) — never a second PGlite instance on the dir.

export type SeedTldrSource = 'auto' | 'fixture' | 'jev';

export interface SeedTldrOptions {
  source: SeedTldrSource;
  /** Rewrite `<slug>.json` from each seeded post's published Jev deck (requires a real key). */
  writeFixture?: boolean;
  /** Fixture directory (default src/server/seed/decks; tests point it at a temp copy). */
  fixtureDir?: string;
}

export interface SeedTldrResult {
  source: 'fixture' | 'jev';
  /** Slugs that got a published deck in this run, in seed order. */
  seeded: string[];
  /** Slugs that already had a published deck (left untouched). */
  skipped: string[];
  /** Slugs that could not be seeded (see `warnings`); the run continued. */
  failed: string[];
  /** Real Jev (OpenRouter) calls made by this run. */
  calls: number;
  /** Total recorded cost of those calls; null when no call was made. */
  costUsd: number | null;
  warnings: string[];
  /** Fixture files rewritten (`writeFixture`). */
  fixturesWritten: string[];
}

export class SeedTldrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedTldrError';
  }
}

/** 'auto' → 'jev' with a real key, else 'fixture'. An explicit 'jev' without a key is an error. */
export function resolveSeedTldrSource(requested: SeedTldrSource, keyConfigured: boolean): 'fixture' | 'jev' {
  if (requested === 'fixture') return 'fixture';
  if (requested === 'jev') {
    if (!keyConfigured) throw new SeedTldrError('seed:tldr with Jev needs a real BLOG0_OPENROUTER_API_KEY in .env.');
    return 'jev';
  }
  return keyConfigured ? 'jev' : 'fixture';
}

/** "decks: N seeded (N calls, $0.0123)" — the line `pnpm seed:tldr` and `pnpm dev:design` print. */
export function formatSeedTldrSummary(result: Pick<SeedTldrResult, 'seeded' | 'calls' | 'costUsd'>): string {
  const calls = `${result.calls} call${result.calls === 1 ? '' : 's'}`;
  const cost = result.costUsd === null ? '' : `, $${result.costUsd.toFixed(4)}`;
  return `decks: ${result.seeded.length} seeded (${calls}${cost})`;
}

type SeedArticle = {
  id: string;
  slug: string;
  status: string;
  currentRevisionId: string | null;
  publishedRevisionId: string | null;
};

async function loadSeedArticles(db: Db, siteId: string): Promise<Map<string, SeedArticle>> {
  const rows = await db
    .select({
      id: article.id,
      slug: article.slug,
      status: article.status,
      currentRevisionId: article.currentRevisionId,
      publishedRevisionId: article.publishedRevisionId,
    })
    .from(article)
    .where(and(eq(article.siteId, siteId), inArray(article.slug, SEED_POSTS.map((p) => p.slug))));
  return new Map(rows.map((r) => [r.slug, r]));
}

async function publishedDeck(db: Db, siteId: string, articleId: string) {
  const [row] = await db
    .select({ publishedPayload: articleFormat.publishedPayload })
    .from(articleFormat)
    .where(and(eq(articleFormat.siteId, siteId), eq(articleFormat.articleId, articleId), eq(articleFormat.kind, 'tldr')))
    .limit(1);
  return readTldrPayload(row?.publishedPayload);
}

async function loadActor(db: Db, siteId: string, userId: string): Promise<ActorContext> {
  const [user] = await db
    .select({ id: appUser.id, siteId: appUser.siteId, email: appUser.email, displayName: appUser.displayName })
    .from(appUser)
    .where(and(eq(appUser.id, userId), eq(appUser.siteId, siteId), isNull(appUser.disabledAt)))
    .limit(1);
  if (!user) throw new SeedTldrError(`User ${userId} is not an admin of this site — run: pnpm db:seed`);
  return { siteId, user };
}

function describeError(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/** Whether an ApiError from generateTldr came after the provider was actually called. */
function generationFromError(error: unknown): { costUsd: number | null } | null {
  if (!(error instanceof ApiError)) return null;
  const generation = (error.details as { generation?: { costUsd: number | null } } | undefined)?.generation;
  return generation ?? null;
}

/**
 * Seeds one published TLDR deck per seeded post (SEED_POSTS slugs present in `siteId`) that has
 * none, as `userId` (an active admin of the site). See the file header for the sources.
 */
export async function seedTldr(db: Db, siteId: string, userId: string, opts: SeedTldrOptions): Promise<SeedTldrResult> {
  const keyConfigured = isLlmConfigured();
  const source = resolveSeedTldrSource(opts.source, keyConfigured);
  if (opts.writeFixture && source !== 'jev') {
    throw new SeedTldrError('--write-fixture captures real Jev output — it needs a real BLOG0_OPENROUTER_API_KEY (and not --source fixture).');
  }
  const fixtureDir = opts.fixtureDir ?? DECKS_DIR;
  const ctx = await loadActor(db, siteId, userId);
  const articles = await loadSeedArticles(db, siteId);

  const result: SeedTldrResult = { source, seeded: [], skipped: [], failed: [], calls: 0, costUsd: null, warnings: [], fixturesWritten: [] };
  const warn = (slug: string, event: string, message: string, fields: Record<string, unknown> = {}) => {
    result.warnings.push(`${slug}: ${message}`);
    log.warn(event, { slug, source, msg: message, ...fields });
  };
  const addCost = (cost: number | null) => {
    result.calls += 1;
    result.costUsd = (result.costUsd ?? 0) + (cost ?? 0);
  };

  for (const post of SEED_POSTS) {
    const row = articles.get(post.slug);
    if (!row) {
      warn(post.slug, 'seed.tldr.skipped', 'not in this site — run: pnpm db:seed:posts');
      result.failed.push(post.slug);
      continue;
    }
    if (await publishedDeck(db, siteId, row.id)) {
      result.skipped.push(post.slug);
      continue;
    }
    if (row.status !== 'published' || row.currentRevisionId === null || row.currentRevisionId !== row.publishedRevisionId) {
      // Publishing here would also publish a writer's unpublished edits — leave it to the writer.
      warn(post.slug, 'seed.tldr.skipped', 'not seeded — the article is unpublished or has unpublished changes; generate and publish its deck from the editor');
      result.failed.push(post.slug);
      continue;
    }
    const revisionId = row.currentRevisionId;

    try {
      if (source === 'jev') {
        let generated: Awaited<ReturnType<typeof generateTldr>>;
        try {
          generated = await generateTldr(ctx, row.id, revisionId, `seed-tldr-${randomUUID()}`);
        } catch (error) {
          const generation = generationFromError(error);
          if (generation) addCost(generation.costUsd);
          throw error;
        }
        addCost(generated.generation.costUsd);
      } else {
        const fixture = loadDeckFixture(post.slug, fixtureDir);
        if (!fixture) {
          warn(post.slug, 'seed.tldr.skipped', `no fixture ${post.slug}.json — run: pnpm seed:tldr -- --write-fixture (real key)`);
          result.failed.push(post.slug);
          continue;
        }
        const [revision] = await db
          .select()
          .from(articleRevision)
          .where(and(eq(articleRevision.id, revisionId), eq(articleRevision.siteId, siteId)))
          .limit(1);
        const rendered = await renderRevision(revision);
        const match = matchFixtureLines(fixture.lines, rendered.sentences);
        for (const text of match.unmatched) {
          warn(post.slug, 'seed.tldr.fixture_line_unmatched', `fixture line dropped — no sentence of the article matches it exactly: "${text.length > 80 ? `${text.slice(0, 77)}...` : text}"`, {
            article_id: row.id,
          });
        }
        if (match.matched.length === 0) {
          warn(post.slug, 'seed.tldr.skipped', 'no fixture line matches the article — deck not seeded');
          result.failed.push(post.slug);
          continue;
        }
        await saveDeck(ctx, row.id, {
          revisionId,
          slides: match.matched.map((m) => ({ sid: m.sid, source: 'writer' as const, reason: null })),
        });
      }
      await publishArticle(ctx, row.id, revisionId);
      result.seeded.push(post.slug);
      log.info('seed.tldr.seeded', { slug: post.slug, source, article_id: row.id });
    } catch (error) {
      warn(post.slug, 'seed.tldr.failed', `deck not seeded — ${describeError(error)} (re-run later)`);
      result.failed.push(post.slug);
    }
  }

  if (opts.writeFixture) {
    for (const post of SEED_POSTS) {
      const written = await captureFixture(db, siteId, articles.get(post.slug), post.slug, fixtureDir);
      if (written.ok) result.fixturesWritten.push(written.file);
      else warn(post.slug, 'seed.tldr.fixture_not_written', written.reason);
    }
  }
  return result;
}

async function captureFixture(
  db: Db,
  siteId: string,
  row: SeedArticle | undefined,
  slug: string,
  dir: string,
): Promise<{ ok: true; file: string } | { ok: false; reason: string }> {
  if (!row) return { ok: false, reason: 'fixture not written — the post is not in this site' };
  const deck = await publishedDeck(db, siteId, row.id);
  if (!deck) return { ok: false, reason: 'fixture not written — no published deck' };
  if (deck.generationId === null || deck.slides.some((s) => s.source !== 'jev')) {
    return { ok: false, reason: 'fixture not written — the published deck is not pure Jev output (editor lines); fixture left unchanged' };
  }
  const [generation] = await db
    .select({ model: aiGeneration.model, promptVersion: aiGeneration.promptVersion, finishedAt: aiGeneration.finishedAt, startedAt: aiGeneration.startedAt })
    .from(aiGeneration)
    .where(and(eq(aiGeneration.id, deck.generationId), eq(aiGeneration.siteId, siteId)))
    .limit(1);
  if (!generation) return { ok: false, reason: 'fixture not written — the deck’s generation record is missing' };
  const file = writeDeckFixture(
    {
      slug,
      model: generation.model,
      promptVersion: generation.promptVersion,
      capturedAt: (generation.finishedAt ?? generation.startedAt).toISOString(),
      lines: deck.slides.map((s) => ({ text: s.text, reason: s.reason ?? '' })),
    },
    dir,
  );
  return { ok: true, file };
}
