// Seed posts (S2.6) against real blog0_test Postgres: `seedPosts` writes the 5 design articles
// through the Phase 1 content pipeline as published articles (one revision each, no format rows),
// is idempotent by slug and never overwrites a later writer edit; plus the legacy-brand upgrade
// `seedSite` applies so an existing DB becomes "blog0" on `pnpm db:seed`.
// No LLM is involved in seeding (decks are S2.7), so there is no real-key call here.
import { and, asc, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { listArticles, updateArticle } from '@/server/articles/service';
import { renderArticle } from '@/server/content';
import { closeDb, getDb } from '@/server/db/client';
import { aiGeneration, article, articleFormat, articleRevision, site, type SiteRow } from '@/server/db/schema';
import { getHomeSections } from '@/server/public/home';
import { resetCurrentSiteForTests } from '@/server/site/current';
import { SITE_DEFAULTS } from '@/server/site/defaults';
import { loadSeedPosts, SEED_POSTS } from '@/server/seed/posts';
import { firstAdminId, publishedAtFor, SeedPostsError, seedPosts } from '@/server/seed/seed-posts';
import { seedSite } from '@/server/seed/site';

import { resetDb } from '../helpers/db';
import { loginAs, type TestLogin } from '../helpers/session';

const ALL_SLUGS = SEED_POSTS.map((p) => p.slug);

let siteRow: SiteRow;
let admin: TestLogin;

beforeEach(async () => {
  siteRow = await resetDb();
  admin = await loginAs({ displayName: 'First Admin' });
});

async function articlesBySlug() {
  const rows = await getDb().select().from(article).where(eq(article.siteId, siteRow.id));
  return new Map(rows.map((r) => [r.slug, r]));
}

describe('seedPosts — first run', () => {
  it('creates the 5 design articles as published, with the spec’d metadata, one revision each', async () => {
    const result = await seedPosts(getDb(), siteRow.id, admin.user.id);
    expect(result.created).toEqual(ALL_SLUGS);
    expect(result.skipped).toEqual([]);

    const rows = await articlesBySlug();
    expect([...rows.keys()].sort()).toEqual([...ALL_SLUGS].sort());

    for (const post of loadSeedPosts()) {
      const a = rows.get(post.slug)!;
      expect(a.status).toBe('published');
      expect(a.topic).toBe(post.topic);
      expect(a.bylineName).toBe('Sai Krishna V');
      expect(a.createdBy).toBe(admin.user.id);
      expect(a.slugIsCustom).toBe(false);
      expect(a.inProgress).toBe(post.slug === 'ai-is-expensive');
      expect(a.isFeatured).toBe(post.featuredRank !== null);
      expect(a.featuredRank).toBe(post.featuredRank);
      expect(a.firstPublishedAt?.toISOString()).toBe(`${post.date}T03:30:00.000Z`); // 09:00 Asia/Kolkata
      expect(a.lastPublishedAt?.toISOString()).toBe(a.firstPublishedAt?.toISOString());
      expect(a.contentUpdatedAt).toBeNull();
      expect(a.currentRevisionId).not.toBeNull();
      expect(a.publishedRevisionId).toBe(a.currentRevisionId);

      const revs = await getDb().select().from(articleRevision).where(eq(articleRevision.articleId, a.id));
      expect(revs).toHaveLength(1);
      const [rev] = revs;
      expect(rev.id).toBe(a.currentRevisionId);
      expect(rev.number).toBe(1);
      expect(rev.title).toBe(post.title);
      expect(rev.dek).toBe(post.dek);
      expect(rev.bodyMd).toBe(post.bodyMd);
      expect(rev.createdBy).toBe(admin.user.id);

      // Through the Phase 1 content pipeline: fingerprints/stats match a fresh render.
      const rendered = await renderArticle({ title: post.title, dek: post.dek, bodyMd: post.bodyMd });
      expect(rev.bodyFingerprint).toBe(rendered.fingerprints.body);
      expect(rev.paragraphsFingerprint).toBe(rendered.fingerprints.paragraphs);
      expect(rev.sentencesFingerprint).toBe(rendered.fingerprints.sentences);
      expect(rev.wordCount).toBe(rendered.stats.words);
      expect(rev.eligibleSentenceCount).toBe(rendered.sentences.length);
      expect(rev.wordCount).toBeGreaterThan(50);
      expect(rev.eligibleSentenceCount).toBeGreaterThan(3);
    }

    // No TLDR, no audio, no AI.
    expect(await getDb().select().from(articleFormat).where(eq(articleFormat.siteId, siteRow.id))).toHaveLength(0);
    expect(await getDb().select().from(aiGeneration).where(eq(aiGeneration.siteId, siteRow.id))).toHaveLength(0);
  });

  it('shows the right dashboard chips and the right home sections', async () => {
    await seedPosts(getDb(), siteRow.id, admin.user.id);

    const items = await listArticles(siteRow.id);
    expect(items).toHaveLength(5);
    for (const item of items) {
      expect(item.status).toBe('published');
      expect(item.hasUnpublishedChanges).toBe(false);
      expect(item.updatedBy).toBe('First Admin');
      const chips = Object.fromEntries(item.formats.map((f) => [f.kind, f]));
      expect(chips.read).toMatchObject({ status: 'ready', published: true, hasUnpublishedChanges: false });
      expect(chips.tldr).toMatchObject({ status: 'missing', published: false, hasUnpublishedChanges: false });
    }

    resetCurrentSiteForTests();
    const home = await getHomeSections(null);
    // Featured by rank (1 → 3), Latest = the other two newest first.
    expect(home.featured.map((c) => c.slug)).toEqual(['ai-will-destroy-the-world', 'tech-company-first', 'humans-are-software']);
    expect(home.latest.map((c) => c.slug)).toEqual(['ai-is-expensive', 'artefact-driven-development']);
    expect(home.latest[0]).toMatchObject({ title: 'AI is Expensive', topic: 'Analysis', inProgress: true, publishedLabel: '29 Sep 2026' });
    expect(home.featured[0].dek).toBe(SEED_POSTS.find((p) => p.slug === 'ai-will-destroy-the-world')!.dek);
  });
});

describe('seedPosts — idempotency', () => {
  it('a second run creates nothing and changes nothing', async () => {
    await seedPosts(getDb(), siteRow.id, admin.user.id);
    const before = await getDb().select().from(article).where(eq(article.siteId, siteRow.id)).orderBy(asc(article.slug));

    const again = await seedPosts(getDb(), siteRow.id, admin.user.id);
    expect(again.created).toEqual([]);
    expect(again.skipped).toEqual(ALL_SLUGS);

    const after = await getDb().select().from(article).where(eq(article.siteId, siteRow.id)).orderBy(asc(article.slug));
    expect(after).toEqual(before);
    expect(await getDb().select().from(articleRevision).where(eq(articleRevision.siteId, siteRow.id))).toHaveLength(5);
  });

  it('never overwrites a later writer edit (multi-interaction: seed → edit → re-seed)', async () => {
    await seedPosts(getDb(), siteRow.id, admin.user.id);
    const target = (await articlesBySlug()).get('humans-are-software')!;
    const ctx = { siteId: siteRow.id, user: admin.user };
    await updateArticle(ctx, target.id, {
      baseRevisionId: target.currentRevisionId!,
      title: 'Humans are Software (revised)',
      topic: 'Essays',
      featuredRank: 7,
      inProgress: true,
    });

    const rerun = await seedPosts(getDb(), siteRow.id, admin.user.id);
    expect(rerun.created).toEqual([]);

    const edited = (await articlesBySlug()).get('humans-are-software')!;
    expect(edited.topic).toBe('Essays');
    expect(edited.featuredRank).toBe(7);
    expect(edited.inProgress).toBe(true);
    const revs = await getDb()
      .select()
      .from(articleRevision)
      .where(eq(articleRevision.articleId, edited.id))
      .orderBy(asc(articleRevision.number));
    expect(revs.map((r) => r.title)).toEqual(['Humans are Software', 'Humans are Software (revised)']);
    expect(edited.currentRevisionId).toBe(revs[1].id);
  });

  it('skips only the slugs that already exist (a writer’s own article on a seed slug is untouched)', async () => {
    // Edge: a hand-made draft already owns one of the seed slugs.
    const [draft] = await getDb()
      .insert(article)
      .values({ siteId: siteRow.id, slug: 'ai-is-expensive', topic: 'Mine', bylineName: 'Someone Else', createdBy: admin.user.id })
      .returning();

    const result = await seedPosts(getDb(), siteRow.id, admin.user.id);
    expect(result.created).toEqual(ALL_SLUGS.filter((s) => s !== 'ai-is-expensive'));
    expect(result.skipped).toEqual(['ai-is-expensive']);

    const kept = (await articlesBySlug()).get('ai-is-expensive')!;
    expect(kept).toEqual(draft);
    expect(kept.status).toBe('draft');
  });

  it('two concurrent runs still produce exactly 5 articles and 5 revisions', async () => {
    const [a, b] = await Promise.all([
      seedPosts(getDb(), siteRow.id, admin.user.id),
      seedPosts(getDb(), siteRow.id, admin.user.id),
    ]);
    expect([...a.created, ...b.created].sort()).toEqual([...ALL_SLUGS].sort());
    expect(await getDb().select().from(article).where(eq(article.siteId, siteRow.id))).toHaveLength(5);
    expect(await getDb().select().from(articleRevision).where(eq(articleRevision.siteId, siteRow.id))).toHaveLength(5);
  });

  it('the seeded posts survive a fresh connection (state survival)', async () => {
    await seedPosts(getDb(), siteRow.id, admin.user.id);
    await closeDb();
    const rows = await getDb()
      .select({ slug: article.slug, status: article.status })
      .from(article)
      .where(and(eq(article.siteId, siteRow.id), eq(article.status, 'published')));
    expect(rows.map((r) => r.slug).sort()).toEqual([...ALL_SLUGS].sort());
    const rerun = await seedPosts(getDb(), siteRow.id, admin.user.id);
    expect(rerun.created).toEqual([]);
  });
});

describe('seedPosts — errors', () => {
  it('refuses a user that is not an admin of the site and writes nothing', async () => {
    const [other] = await getDb()
      .insert(site)
      .values({ ...SITE_DEFAULTS, slug: 'other-site' })
      .returning();
    await expect(seedPosts(getDb(), other.id, admin.user.id)).rejects.toThrow(SeedPostsError);
    await expect(seedPosts(getDb(), siteRow.id, '00000000-0000-4000-8000-000000000000')).rejects.toThrow(/not an admin of this site/);
    expect(await getDb().select().from(article)).toHaveLength(0);
  });

  it('refuses an unknown site', async () => {
    await expect(seedPosts(getDb(), '00000000-0000-4000-8000-000000000000', admin.user.id)).rejects.toThrow(/run: pnpm db:seed/);
  });

  it('firstAdminId picks the earliest active admin, or null when the site has none', async () => {
    await loginAs({ displayName: 'Second Admin' });
    expect(await firstAdminId(getDb(), siteRow.id)).toBe(admin.user.id);

    const [empty] = await getDb()
      .insert(site)
      .values({ ...SITE_DEFAULTS, slug: 'empty-site' })
      .returning();
    expect(await firstAdminId(getDb(), empty.id)).toBeNull();
  });
});

describe('publishedAtFor', () => {
  it('is the design date at 09:00 in the site timezone', () => {
    expect(publishedAtFor('2026-09-08', 'Asia/Kolkata').toISOString()).toBe('2026-09-08T03:30:00.000Z');
    expect(publishedAtFor('2026-09-08', 'UTC').toISOString()).toBe('2026-09-08T09:00:00.000Z');
    expect(publishedAtFor('2026-01-15', 'America/New_York').toISOString()).toBe('2026-01-15T14:00:00.000Z');
    expect(publishedAtFor('2026-07-15', 'America/New_York').toISOString()).toBe('2026-07-15T13:00:00.000Z');
  });

  it('rejects a malformed date', () => {
    expect(() => publishedAtFor('2026-9-8', 'UTC')).toThrow(SeedPostsError);
  });
});

describe('seedSite — legacy brand upgrade', () => {
  it('rewrites a "log0" wordmark/brand to blog0 on an existing row, once', async () => {
    await getDb().update(site).set({ wordmark: 'log0', brandName: 'log0', tagline: 'Edited by an admin' }).where(eq(site.id, siteRow.id));

    const first = await seedSite(getDb(), siteRow.slug);
    expect(first.status).toBe('ok');
    expect(first.site.wordmark).toBe('blog0');
    expect(first.site.brandName).toBe('blog0');
    expect(first.site.tagline).toBe('Edited by an admin');

    const second = await seedSite(getDb(), siteRow.slug);
    expect(second.site).toEqual(first.site);
  });

  it('leaves any other wordmark alone', async () => {
    await getDb().update(site).set({ wordmark: 'Custom', brandName: 'Custom Co' }).where(eq(site.id, siteRow.id));
    const result = await seedSite(getDb(), siteRow.slug);
    expect(result.site.wordmark).toBe('Custom');
    expect(result.site.brandName).toBe('Custom Co');
  });
});
