// Designer mode (S2.8; spec/architecture.md §11, capability designer-mode) on a real embedded
// PGlite (`pglite://memory`): the SAME migrations and seeds as Postgres, the generated designer
// admin + session secret, health reporting `dbEngine: 'pglite'`, Jev refusing with
// LLM_NOT_CONFIGURED when no key is set, and — with the real OpenRouter key — one real Generate
// plus the save/publish/update transactions completing on PGlite (spike quirk 1: an outer-`db`
// query inside a transaction deadlocks there, so this suite would hang on such a bug).
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { POST as loginRoute } from '@/app/api/auth/login/route';
import { GET as healthRoute } from '@/app/api/health/route';
import type { HealthPhase2Dto } from '@/lib/api/dto-phase2';
import type { Envelope } from '@/lib/api/envelope';
import { createArticle, publishArticle, updateArticle, type ActorContext } from '@/server/articles/service';
import { generateTldr, getTldrState, saveDeck } from '@/server/articles/tldr';
import { verifyPassword } from '@/server/auth/password';
import { loadConfig, resetConfigForTests } from '@/server/config';
import { closeDb, getDb, getDbHandle, initDb, resetDbForTests } from '@/server/db/client';
import { getMigrationStatus, runMigrations } from '@/server/db/migrate';
import { aiGeneration, appUser, article } from '@/server/db/schema';
import { DESIGNER_ADMIN_EMAIL, ensureDesignerAdmin } from '@/server/designer/admin';
import { DesignerSecretError, ensureDesignerSessionSecret } from '@/server/designer/secret';
import { designerAdminFileFor } from '@/server/designer/setup';
import { ApiError } from '@/server/http/api';
import { resetLlmClientForTests } from '@/server/llm';
import { openRouterKeyStatus, PENDING_KEY_REASON } from '@/server/llm/key';
import { resetLoggerForTests } from '@/server/log';
import { seedPosts } from '@/server/seed/seed-posts';
import { seedSite } from '@/server/seed/site';
import { resetCurrentSiteForTests } from '@/server/site/current';

const ORIGIN = 'http://localhost:3410';
const routeCtx = { params: Promise.resolve({}) };
const SAVED_ENV = ['BLOG0_DATABASE_URL', 'BLOG0_OPENROUTER_API_KEY'] as const;
const saved: Record<string, string | undefined> = {};
const realKey = process.env.BLOG0_OPENROUTER_API_KEY;
const keyStatus = openRouterKeyStatus(realKey);
const pendingKey = keyStatus !== 'real';
if (pendingKey && process.env.CI !== 'true') console.warn(`[designer-mode] ${PENDING_KEY_REASON}; the real Generate-on-PGlite test is skipped.`);

const tmp = mkdtempSync(path.join(tmpdir(), 'blog0-designer-'));
const adminFile = path.join(tmp, 'designer-admin.txt');

function resetSingletons(): void {
  resetConfigForTests();
  resetLlmClientForTests();
  resetCurrentSiteForTests();
  resetLoggerForTests();
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

    expect(applied).toEqual(['0000_init']);
    expect(status.engine).toBe('pglite');
    expect(status.pending).toEqual([]);
    expect(status.latestApplied).toBe('0000_init');
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
    const body = (await response.json()) as Envelope<HealthPhase2Dto>;

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

  it.skipIf(pendingKey)(
    'with the real key: create → Generate (one real call) → save deck → publish → edit all complete on PGlite (no tx deadlock)',
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
        const slides = generated.tldr.draft!.slides;
        expect(slides.length).toBeGreaterThanOrEqual(1);
        expect(generated.tldr.jevAvailable).toBe(true);

        const savedDeck = await noDeadlock(
          'saveDeck',
          saveDeck(ctx, created.id, { revisionId, slides: slides.map((s) => ({ sid: s.sid, source: s.source, reason: s.reason })) }),
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
