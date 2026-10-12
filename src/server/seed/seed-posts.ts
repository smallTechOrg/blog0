import 'server-only';

import { and, asc, eq, isNull } from 'drizzle-orm';

import { renderArticle } from '../content/render';
import type { Db, Tx } from '../db/client';
import { appUser, article, articleRevision, site } from '../db/schema';
import { formatAdapters } from '../formats';

import { loadSeedPosts, type SeedPost } from './posts';

// `pnpm db:seed:posts` (spec/data.md → Seed data): the 5 design articles as published articles,
// each rendered through the Phase 1 content pipeline (revision fingerprints/stats exactly as a
// save would compute them), one revision each, no format rows (no TLDR, no audio), so the
// dashboard chips read "Read ready/published, TLDR missing". Idempotent by slug: an existing
// slug — seeded earlier or a writer's own article — is never touched, so later edits survive.
// Coded against the Drizzle `db` handle only (Postgres or PGlite); inside the transaction every
// call gets `tx`, never the outer `db` (PGlite is single-connection and would deadlock).

export class SeedPostsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedPostsError';
  }
}

export interface SeedPostsResult {
  /** Slugs inserted by this run, in seed order. */
  created: string[];
  /** Slugs that already existed in the site (left untouched), in seed order. */
  skipped: string[];
}

/** Local hour at which a design date is published (spec: "design date 09:00 site timezone"). */
const PUBLISH_HOUR = 9;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return asUtc - instant.getTime();
}

/** `YYYY-MM-DD` at 09:00 wall-clock time in `timeZone`, as a UTC instant. */
export function publishedAtFor(date: string, timeZone: string): Date {
  const m = DATE_RE.exec(date);
  if (!m) throw new SeedPostsError(`Seed date '${date}' is not YYYY-MM-DD.`);
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), PUBLISH_HOUR);
  // Two passes settle the offset even when the guess lands on the other side of a DST change.
  let instant = wall - zoneOffsetMs(new Date(wall), timeZone);
  instant = wall - zoneOffsetMs(new Date(instant), timeZone);
  return new Date(instant);
}

/** The site's earliest-created active admin (the seed author), or null when it has none. */
export async function firstAdminId(db: Db, siteId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: appUser.id })
    .from(appUser)
    .where(and(eq(appUser.siteId, siteId), isNull(appUser.disabledAt)))
    .orderBy(asc(appUser.createdAt), asc(appUser.id))
    .limit(1);
  return row?.id ?? null;
}

/** Inserts one seed post; returns false when the slug already exists in the site. */
async function insertSeedPost(
  tx: Tx,
  args: { siteId: string; userId: string; timeZone: string; post: SeedPost & { bodyMd: string } },
): Promise<boolean> {
  const { siteId, userId, post } = args;
  const content = { title: post.title, dek: post.dek, bodyMd: post.bodyMd };
  if (content.title.trim() === '' || post.topic.trim() === '' || content.bodyMd.trim() === '') {
    throw new SeedPostsError(`Seed post '${post.slug}' needs a title, a topic and a body to be published.`);
  }
  const rendered = await renderArticle(content);
  const at = publishedAtFor(post.date, args.timeZone);

  const [row] = await tx
    .insert(article)
    .values({
      siteId,
      slug: post.slug,
      slugIsCustom: false,
      status: 'draft',
      topic: post.topic,
      bylineName: post.bylineName,
      createdBy: userId,
      isFeatured: post.featuredRank !== null,
      featuredRank: post.featuredRank,
      inProgress: post.inProgress,
      createdAt: at,
      updatedAt: at,
    })
    .onConflictDoNothing({ target: [article.siteId, article.slug] })
    .returning();
  if (!row) return false;

  const [revision] = await tx
    .insert(articleRevision)
    .values({
      siteId,
      articleId: row.id,
      number: 1,
      title: content.title,
      dek: content.dek,
      bodyMd: content.bodyMd,
      bodyFingerprint: rendered.fingerprints.body,
      paragraphsFingerprint: rendered.fingerprints.paragraphs,
      sentencesFingerprint: rendered.fingerprints.sentences,
      wordCount: rendered.stats.words,
      eligibleSentenceCount: rendered.sentences.length,
      createdBy: userId,
      createdAt: at,
    })
    .returning();

  // Publish exactly as publishArticle() does for a first publish (no prior revision → no
  // content_updated_at), then let every format adapter publish (no rows yet → no-ops).
  await tx
    .update(article)
    .set({
      status: 'published',
      currentRevisionId: revision.id,
      publishedRevisionId: revision.id,
      firstPublishedAt: at,
      lastPublishedAt: at,
      contentUpdatedAt: null,
      updatedAt: at,
    })
    .where(and(eq(article.id, row.id), eq(article.siteId, siteId)));
  for (const adapter of formatAdapters()) {
    await adapter.publish(tx, { row: null, revision, userId, now: at });
  }
  return true;
}

/**
 * Seeds the 5 design articles into `siteId`, authored by `userId` (must be an active admin of
 * that site). Each article is its own transaction, so a slug lost to a concurrent run is skipped.
 */
export async function seedPosts(db: Db, siteId: string, userId: string): Promise<SeedPostsResult> {
  const [siteRow] = await db.select({ id: site.id, timezone: site.timezone }).from(site).where(eq(site.id, siteId)).limit(1);
  if (!siteRow) throw new SeedPostsError(`Site ${siteId} does not exist — run: pnpm db:seed`);
  const [user] = await db
    .select({ id: appUser.id })
    .from(appUser)
    .where(and(eq(appUser.id, userId), eq(appUser.siteId, siteId), isNull(appUser.disabledAt)))
    .limit(1);
  if (!user) throw new SeedPostsError(`User ${userId} is not an admin of this site — run: pnpm db:seed`);

  const posts = loadSeedPosts();
  const result: SeedPostsResult = { created: [], skipped: [] };
  for (const post of posts) {
    const created = await db.transaction((tx) => insertSeedPost(tx, { siteId, userId, timeZone: siteRow.timezone, post }));
    (created ? result.created : result.skipped).push(post.slug);
  }
  return result;
}
