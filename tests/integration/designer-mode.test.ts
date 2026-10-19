// Designer mode (spec/architecture.md §11, capability designer-mode) on a real embedded
// PGlite (`pglite://memory`): the SAME migrations and seeds as Postgres, the generated designer
// admin + session secret, health reporting `dbEngine: 'pglite'`, Jev refusing with
// LLM_NOT_CONFIGURED when no key is set, and — with the real OpenRouter key — one real Generate
// plus the save/publish/update transactions completing on PGlite (spike quirk 1: an outer-`db`
// query inside a transaction deadlocks there, so this suite would hang on such a bug).
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { POST as loginRoute } from '@/app/api/auth/login/route';
import { GET as healthRoute } from '@/app/api/health/route';
import type { HealthDto } from '@/lib/api/dto';
import type { Envelope } from '@/lib/api/envelope';
import { createArticle, publishArticle, updateArticle, type ActorContext } from '@/server/articles/service';
import { generateTldr, getTldrState, saveDeck } from '@/server/articles/tldr';
import { verifyPassword } from '@/server/auth/password';
import { loadConfig, resetConfigForTests } from '@/server/config';
import { closeDb, getDb, getDbHandle, initDb, resetDbForTests } from '@/server/db/client';
import { getMigrationStatus, runMigrations } from '@/server/db/migrate';
import { aiGeneration, appUser, article, articleFormat, mediaAsset } from '@/server/db/schema';
import { DESIGNER_ADMIN_EMAIL, ensureDesignerAdmin } from '@/server/designer/admin';
import { DesignerSecretError, ensureDesignerSessionSecret } from '@/server/designer/secret';
import { designerAdminFileFor, formatSampleListenSummary, SAMPLE_LISTEN_SLUG, seedSampleListen } from '@/server/designer/setup';
import { readListenPayload } from '@/server/formats/payload';
import { ApiError } from '@/server/http/api';
import { resetLlmClientForTests } from '@/server/llm';
import { openRouterKeyStatus, PENDING_KEY_REASON, realKeyRequired } from '@/server/llm/key';
import { resetLoggerForTests } from '@/server/log';
import { seedPosts } from '@/server/seed/seed-posts';
import { seedSite } from '@/server/seed/site';
import { getPublishedArticle } from '@/server/public/articles';
import { resetCurrentSiteForTests } from '@/server/site/current';
import { resetStorageForTests } from '@/server/storage';

const ORIGIN = 'http://localhost:3410';
const routeCtx = { params: Promise.resolve({}) };
const SAVED_ENV = ['BLOG0_DATABASE_URL', 'BLOG0_OPENROUTER_API_KEY', 'BLOG0_STORAGE_DIR'] as const;
const saved: Record<string, string | undefined> = {};
const realKey = process.env.BLOG0_OPENROUTER_API_KEY;
const keyStatus = openRouterKeyStatus(realKey);
const pendingKey = keyStatus !== 'real';
const keyRequired = realKeyRequired(process.env);
if (pendingKey && !keyRequired) console.warn(`[designer-mode] ${PENDING_KEY_REASON} (key ${keyStatus}); the real Generate-on-PGlite test is skipped.`);

describe.runIf(pendingKey && keyRequired)('designer-mode real-key requirement (BLOG0_REQUIRE_REAL_KEY=1 / CI)', () => {
  it(`fails: ${PENDING_KEY_REASON} (a real key is required: BLOG0_REQUIRE_REAL_KEY=1 or CI=true)`, () => {
    throw new Error(`${PENDING_KEY_REASON} (key ${keyStatus}) — a real OpenRouter key is required (BLOG0_REQUIRE_REAL_KEY=1, or CI=true when unset); this is a failure, not a skip.`);
  });
});

const tmp = mkdtempSync(path.join(tmpdir(), 'blog0-designer-'));
const adminFile = path.join(tmp, 'designer-admin.txt');
const storageDir = path.join(tmp, 'storage');
const SAMPLE_MP3 = path.join(process.cwd(), 'tests', 'fixtures', 'audio', 'sample.mp3');
const SAMPLE_META = JSON.parse(readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'audio', 'sample.json'), 'utf8')) as {
  mp3: { durationMs: number; bytes: number };
};

function resetSingletons(): void {
  resetConfigForTests();
  resetLlmClientForTests();
  resetCurrentSiteForTests();
  resetLoggerForTests();
  resetStorageForTests();
}

/** Fails (instead of hanging the suite) if a PGlite transaction deadlocks. */
async function noDeadlock<T>(label: string, p: Promise<T>, ms = 90_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms} ms on PGlite (transaction deadlock?)`)), ms);
  });
  try {
    return await Promise.race([p, guard]);
  } finally {
    clearTimeout(timer);
  }
}

let siteId = '';
let ctx: ActorContext;
let designerPassword = '';

beforeAll(async () => {
  for (const name of SAVED_ENV) saved[name] = process.env[name];
  process.env.BLOG0_DATABASE_URL = 'pglite://memory';
  process.env.BLOG0_OPENROUTER_API_KEY = ''; // designer machine: no key
  process.env.BLOG0_STORAGE_DIR = storageDir;
  await resetDbForTests();
  resetSingletons();
  const handle = await initDb();
  expect(handle.engine).toBe('pglite');
});

afterAll(async () => {
  await closeDb();
  for (const name of SAVED_ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  resetSingletons();
  rmSync(tmp, { recursive: true, force: true });
});

describe('designer mode on embedded PGlite (pglite://memory)', () => {
  it('applies the same migration folder: 0 pending, PostgreSQL 17 under PGlite', async () => {
    const applied = await runMigrations(getDbHandle());
    const status = await getMigrationStatus(getDbHandle());

    expect(applied).toEqual(['0000_init', '0001_rate_limit_bucket', '0002_newsletter', '0003_newsletter_prune_fix', '0004_newsletter_erasure', '0005_newsletter_erase_delete']);
    expect(status.engine).toBe('pglite');
    expect(status.pending).toEqual([]);
    expect(status.latestApplied).toBe('0005_newsletter_erase_delete');
    expect(status.serverVersion).toMatch(/^17\./);
    expect(await runMigrations(getDbHandle())).toEqual([]); // idempotent
  });

  it('seeds the site, the designer admin (password returned once, file 0600) and the 5 posts; a re-run creates nothing', async () => {
    const db = getDb();
    const siteResult = await seedSite(db, 'blog0');
    siteId = siteResult.site.id;

    const first = await ensureDesignerAdmin(db, siteId, { file: adminFile });
    const second = await ensureDesignerAdmin(db, siteId, { file: adminFile });

    expect(first.status).toBe('created');
    expect(first.email).toBe(DESIGNER_ADMIN_EMAIL);
    expect(first.password).toMatch(/^[A-Za-z0-9_-]{24}$/);
    designerPassword = first.password!;
    expect(second).toMatchObject({ status: 'exists', password: null, fileExists: true, userId: first.userId });
    const fileText = readFileSync(adminFile, 'utf8');
    expect(fileText).toContain(`email: ${DESIGNER_ADMIN_EMAIL}`);
    expect(fileText).toContain(`password: ${designerPassword}`);
    expect(statSync(adminFile).mode & 0o777).toBe(0o600);
    const [row] = await db.select().from(appUser).where(eq(appUser.email, DESIGNER_ADMIN_EMAIL));
    expect(row.displayName).toBe('Designer');
    expect(await verifyPassword(row.passwordHash, designerPassword)).toBe(true);

    const posts = await seedPosts(db, siteId, first.userId);
    const again = await seedPosts(db, siteId, first.userId);
    expect(posts.created).toHaveLength(5);
    expect(again.created).toEqual([]);
    expect(again.skipped).toHaveLength(5);
    const [{ n }] = await db.select({ n: count() }).from(article).where(eq(article.status, 'published'));
    expect(n).toBe(5);

    ctx = { siteId, user: { id: row.id, siteId, email: row.email, displayName: row.displayName } };
  });

  it('seeds ONE published sample recording on humans-are-software (estimated timing, file via the storage interface); a re-run adds nothing', async () => {
    const db = getDb();
    const designer = ctx.user.id;

    const first = await seedSampleListen(db, siteId, designer);
    const second = await seedSampleListen(db, siteId, designer);

    expect(first).toEqual({ status: 'seeded', slug: SAMPLE_LISTEN_SLUG, timing: 'estimated' });
    expect(formatSampleListenSummary(first)).toBe('listen: sample recording seeded on humans-are-software (estimated timing)');
    expect(second).toEqual({ status: 'exists', slug: SAMPLE_LISTEN_SLUG });
    const assets = await db.select().from(mediaAsset);
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({ kind: 'audio', mimeType: 'audio/mpeg', byteSize: SAMPLE_META.mp3.bytes });
    expect(existsSync(path.join(storageDir, assets[0].storageKey))).toBe(true);
    const formats = await db.select().from(articleFormat).where(eq(articleFormat.kind, 'listen'));
    expect(formats).toHaveLength(1);
    const published = readListenPayload(formats[0].publishedPayload);
    expect(published?.audio.key).toBe(assets[0].storageKey);
    expect(published?.marks).toEqual([]);

    const reader = await getPublishedArticle(SAMPLE_LISTEN_SLUG);
    expect(reader?.listen).toMatchObject({ timing: 'estimated', mimeType: 'audio/mpeg', audioUrl: `/media/${assets[0].storageKey}` });
    expect(Math.abs(reader!.listen!.durationMs - SAMPLE_META.mp3.durationMs)).toBeLessThanOrEqual(500);
    expect(reader!.listen!.marks.length).toBeGreaterThan(0);
  });

  it('restores the sample file when only the storage dir was wiped; never re-adds a recording the designer removed', async () => {
    const db = getDb();
    const [asset] = await db.select().from(mediaAsset);
    const file = path.join(storageDir, asset.storageKey);
    rmSync(storageDir, { recursive: true, force: true });

    const restored = await seedSampleListen(db, siteId, ctx.user.id);

    expect(restored).toEqual({ status: 'restored', slug: SAMPLE_LISTEN_SLUG });
    expect(readFileSync(file).equals(readFileSync(SAMPLE_MP3))).toBe(true);
    // A Listen row the designer emptied stays empty (status 'exists', nothing written).
    await db.update(articleFormat).set({ draftPayload: null, publishedPayload: null }).where(eq(articleFormat.kind, 'listen'));
    expect(await seedSampleListen(db, siteId, ctx.user.id)).toEqual({ status: 'exists', slug: SAMPLE_LISTEN_SLUG });
    expect(await db.select().from(mediaAsset)).toHaveLength(1);
  });

  it('skips (never throws) when the fixture or the article is missing, writing nothing', async () => {
    const db = getDb();

    const noFile = await seedSampleListen(db, siteId, ctx.user.id, { slug: 'ai-is-expensive', file: path.join(tmp, 'missing.mp3') });
    const noArticle = await seedSampleListen(db, siteId, ctx.user.id, { slug: 'no-such-post' });

    expect(noFile).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/missing\.mp3 is missing$/) });
    expect(formatSampleListenSummary(noArticle)).toBe('listen: sample recording skipped — no-such-post is not in this site');
    expect(await db.select().from(mediaAsset)).toHaveLength(1);
    expect(await db.select().from(articleFormat).where(eq(articleFormat.kind, 'listen'))).toHaveLength(1);
  });

  it('rotates the designer password only on request and rewrites the file', async () => {
    const rotated = await ensureDesignerAdmin(getDb(), siteId, { file: adminFile, resetPassword: true });

    expect(rotated.status).toBe('password_reset');
    expect(rotated.password).not.toBe(designerPassword);
    expect(readFileSync(adminFile, 'utf8')).toContain(`password: ${rotated.password}`);
    designerPassword = rotated.password!;
  });

  it('signs the designer in through the real login route (argon2 + session on PGlite)', async () => {
    const response = await loginRoute(
      new Request(`${ORIGIN}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, host: 'localhost:3410', 'user-agent': 'vitest-designer' },
        body: JSON.stringify({ email: DESIGNER_ADMIN_EMAIL, password: designerPassword }),
      }),
      routeCtx,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toMatch(/^blog0_session=/);
    const wrong = await loginRoute(
      new Request(`${ORIGIN}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, host: 'localhost:3410', 'user-agent': 'vitest-designer' },
        body: JSON.stringify({ email: DESIGNER_ADMIN_EMAIL, password: 'not-the-designer-password' }),
      }),
      routeCtx,
    );
    expect(wrong.status).toBe(401);
  });

  it('reports the engine from /api/health', async () => {
    const response = await healthRoute(new Request(`${ORIGIN}/api/health`), routeCtx);
    const body = (await response.json()) as Envelope<HealthDto>;

    expect(response.status).toBe(200);
    expect(body.ok && body.data).toMatchObject({ status: 'ok', db: 'ok', dbEngine: 'pglite' });
  });

  it('with no OpenRouter key: jevAvailable is false and Generate answers LLM_NOT_CONFIGURED before writing any row', async () => {
    const [seeded] = await getDb().select().from(article).where(eq(article.slug, 'humans-are-software'));
    const state = await getTldrState(siteId, seeded.id);
    expect(state.jevAvailable).toBe(false);

    const attempt = generateTldr(ctx, seeded.id, seeded.currentRevisionId!, 'req-designer-no-key');
    await expect(attempt).rejects.toBeInstanceOf(ApiError);
    await expect(generateTldr(ctx, seeded.id, seeded.currentRevisionId!, 'req-designer-no-key')).rejects.toMatchObject({
      code: 'LLM_NOT_CONFIGURED',
      status: 503,
      message: expect.stringMatching(/^No OpenRouter key configured — add BLOG0_OPENROUTER_API_KEY to \.env/),
    });
    const [{ n }] = await getDb().select({ n: count() }).from(aiGeneration);
    expect(n).toBe(0);
  });

  const realTitle = 'with the real key: create → Generate (one real call) → save deck → publish → edit all complete on PGlite (no tx deadlock)';
  it.skipIf(pendingKey)(
    pendingKey ? `${realTitle} — ${PENDING_KEY_REASON}` : realTitle,
    async () => {
      process.env.BLOG0_OPENROUTER_API_KEY = realKey;
      resetConfigForTests();
      resetLlmClientForTests();
      try {
        const created = await noDeadlock(
          'createArticle',
          createArticle(ctx, {
            title: 'Designer mode on PGlite',
            topic: 'Engineering',
            dek: 'The same app, no database server.',
            bodyMd: [
              'Designer mode runs the whole site on an embedded database. Nothing needs to be installed beyond Node and pnpm.',
              '',
              'The same migrations run on both engines. The same seeds fill both databases with the same five articles.',
              '',
              'Jev still makes the deck when a key is present. Every slide is a sentence taken verbatim from the article.',
            ].join('\n'),
          }),
        );
        const revisionId = created.currentRevision.id;
        expect((await getTldrState(siteId, created.id)).jevAvailable).toBe(true);

        const generated = await noDeadlock('generateTldr', generateTldr(ctx, created.id, revisionId, 'req-designer-real'));
        expect(generated.generation.status).toBe('succeeded');
        expect(generated.generation.totalTokens).toBeGreaterThan(0);
        expect(generated.generation).toMatchObject({ model: 'typesafe/jev-1.13', promptVersion: 'jev-rank-v1', attempts: 1 });
        const slides = generated.tldr.draft!.slides;
        expect(slides).toHaveLength(generated.tldr.bounds!.target);
        expect(slides.every((s) => typeof s.relevance === 'number')).toBe(true);
        expect(generated.tldr.sentences.every((s) => typeof s.relevance === 'number')).toBe(true);
        expect(generated.tldr.jevAvailable).toBe(true);

        const savedDeck = await noDeadlock(
          'saveDeck',
          saveDeck(ctx, created.id, { revisionId, slides: slides.map((s) => ({ sid: s.sid, source: s.source })) }),
        );
        expect(savedDeck.draft!.slides.map((s) => s.text)).toEqual(slides.map((s) => s.text));

        const published = await noDeadlock('publishArticle', publishArticle(ctx, created.id, revisionId));
        expect(published.status).toBe('published');

        const updated = await noDeadlock('updateArticle', updateArticle(ctx, created.id, { baseRevisionId: revisionId, dek: 'Edited on PGlite.' }));
        expect(updated.revisionCreated).toBe(true);
        const rows = await getDb().select().from(aiGeneration).where(eq(aiGeneration.articleId, created.id));
        expect(rows.map((r) => r.status)).toEqual(['succeeded']);
      } finally {
        process.env.BLOG0_OPENROUTER_API_KEY = '';
        resetConfigForTests();
        resetLlmClientForTests();
      }
    },
  );
});

describe('designer admin credentials file', () => {
  it('is var/designer-admin.txt for the default dir and a sibling file for any other dir', () => {
    expect(designerAdminFileFor('./var/pglite')).toBe(path.join('var', 'designer-admin.txt'));
    expect(designerAdminFileFor('var/pglite/')).toBe(path.join('var', 'designer-admin.txt'));
    expect(designerAdminFileFor('./var/pglite-e2e')).toBe(path.join('var', 'pglite-e2e.designer-admin.txt'));
    expect(designerAdminFileFor('/tmp/x/')).toBe('/tmp/x.designer-admin.txt');
  });
});

describe('designer session secret (var/pglite-session-secret)', () => {
  it('is generated once (48 random bytes, mode 0600) and read back unchanged on later boots', () => {
    const file = path.join(tmp, 'secret-a');

    const first = ensureDesignerSessionSecret(file);
    const second = ensureDesignerSessionSecret(file);

    expect(first.created).toBe(true);
    expect(first.secret).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(second).toEqual({ secret: first.secret, created: false, file });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const config = loadConfig({ BLOG0_DATABASE_URL: 'pglite://memory' }, { designerSessionSecret: () => ensureDesignerSessionSecret(file).secret });
    expect(config.sessionSecret.reveal()).toBe(first.secret);
    expect(config.sessionSecretSource).toBe('generated');
  });

  it('refuses a damaged secret file with a fix-it message instead of booting with a weak secret', () => {
    const file = path.join(tmp, 'secret-b');
    writeFileSync(file, 'short\n', { mode: 0o600 });

    expect(() => ensureDesignerSessionSecret(file)).toThrow(DesignerSecretError);
    expect(() => ensureDesignerSessionSecret(file)).toThrow(/delete it and restart/);
  });
});
