import 'server-only';

import { and, asc, count, desc, eq, inArray, like, ne, sql } from 'drizzle-orm';

import { getDb, type Executor, type Tx } from '../db/client';
import {
  aiGeneration,
  appUser,
  article,
  articleFormat,
  articleRevision,
  type AiGenerationRow,
  type ArticleFormatRow,
  type ArticleRow,
  type RevisionRow,
} from '../db/schema';

// Data access for articles, revisions, formats and generations. Every query filters by site id.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export async function findArticle(siteId: string, id: string, db: Executor = getDb()): Promise<ArticleRow | null> {
  if (!isUuid(id)) return null;
  const [row] = await db
    .select()
    .from(article)
    .where(and(eq(article.siteId, siteId), eq(article.id, id)))
    .limit(1);
  return row ?? null;
}

/** SELECT … FOR UPDATE: serialises saves, publishes and Generate clicks on one article. */
export async function lockArticle(tx: Tx, siteId: string, id: string): Promise<ArticleRow | null> {
  if (!isUuid(id)) return null;
  const [row] = await tx
    .select()
    .from(article)
    .where(and(eq(article.siteId, siteId), eq(article.id, id)))
    .limit(1)
    .for('update');
  return row ?? null;
}

export async function findRevision(siteId: string, id: string | null, db: Executor = getDb()): Promise<RevisionRow | null> {
  if (!id || !isUuid(id)) return null;
  const [row] = await db
    .select()
    .from(articleRevision)
    .where(and(eq(articleRevision.siteId, siteId), eq(articleRevision.id, id)))
    .limit(1);
  return row ?? null;
}

/** The article's current revision (every article has one outside its creating transaction). */
export async function requireCurrentRevision(siteId: string, row: ArticleRow, db: Executor = getDb()): Promise<RevisionRow> {
  const rev = await findRevision(siteId, row.currentRevisionId, db);
  if (!rev) throw new Error(`Article ${row.id} has no current revision`);
  return rev;
}

export async function revisionCount(siteId: string, articleId: string, db: Executor = getDb()): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(articleRevision)
    .where(and(eq(articleRevision.siteId, siteId), eq(articleRevision.articleId, articleId)));
  return Number(row?.n ?? 0);
}

/** Slugs in the site equal to `base` or starting with `base-` (optionally excluding one article). */
export async function takenSlugs(siteId: string, base: string, excludeArticleId: string | null, db: Executor = getDb()): Promise<Set<string>> {
  const conditions = [eq(article.siteId, siteId), like(article.slug, `${base}%`)];
  if (excludeArticleId) conditions.push(ne(article.id, excludeArticleId));
  const rows = await db.select({ slug: article.slug }).from(article).where(and(...conditions));
  return new Set(rows.map((r) => r.slug));
}

export async function slugInUse(siteId: string, slug: string, excludeArticleId: string, db: Executor = getDb()): Promise<boolean> {
  const [row] = await db
    .select({ id: article.id })
    .from(article)
    .where(and(eq(article.siteId, siteId), eq(article.slug, slug), ne(article.id, excludeArticleId)))
    .limit(1);
  return !!row;
}

export async function userNames(siteId: string, ids: Iterable<string | null | undefined>, db: Executor = getDb()): Promise<Map<string, string>> {
  const unique = [...new Set([...ids].filter((v): v is string => !!v))];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: appUser.id, displayName: appUser.displayName })
    .from(appUser)
    .where(and(eq(appUser.siteId, siteId), inArray(appUser.id, unique)));
  return new Map(rows.map((r) => [r.id, r.displayName]));
}

export async function siteTopics(siteId: string, db: Executor = getDb()): Promise<string[]> {
  const rows = await db
    .selectDistinct({ topic: article.topic })
    .from(article)
    .where(and(eq(article.siteId, siteId), ne(article.topic, '')))
    .orderBy(asc(article.topic));
  return rows.map((r) => r.topic);
}

export async function formatRows(siteId: string, articleIds: string[], db: Executor = getDb()): Promise<ArticleFormatRow[]> {
  if (articleIds.length === 0) return [];
  return db
    .select()
    .from(articleFormat)
    .where(and(eq(articleFormat.siteId, siteId), inArray(articleFormat.articleId, articleIds)));
}

export async function findFormatRow(siteId: string, articleId: string, kind: string, db: Executor = getDb()): Promise<ArticleFormatRow | null> {
  const [row] = await db
    .select()
    .from(articleFormat)
    .where(and(eq(articleFormat.siteId, siteId), eq(articleFormat.articleId, articleId), eq(articleFormat.kind, kind)))
    .limit(1);
  return row ?? null;
}

/** Insert-or-update the draft side of the article's `kind` format row. */
export async function upsertFormatDraft(
  tx: Tx,
  siteId: string,
  articleId: string,
  kind: string,
  draft: Partial<Pick<ArticleFormatRow, 'draftPayload' | 'draftRevisionId' | 'draftFingerprint' | 'draftUpdatedBy' | 'draftUpdatedAt' | 'updatedAt'>>,
): Promise<void> {
  await tx
    .insert(articleFormat)
    .values({ siteId, articleId, kind, ...draft })
    .onConflictDoUpdate({ target: [articleFormat.articleId, articleFormat.kind], set: draft, setWhere: eq(articleFormat.siteId, siteId) });
}

/** Latest generation per article for a format kind. */
export async function latestGenerations(
  siteId: string,
  articleIds: string[],
  formatKind: string,
  db: Executor = getDb(),
): Promise<Map<string, AiGenerationRow>> {
  if (articleIds.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([aiGeneration.articleId])
    .from(aiGeneration)
    .where(
      and(eq(aiGeneration.siteId, siteId), inArray(aiGeneration.articleId, articleIds), eq(aiGeneration.formatKind, formatKind)),
    )
    .orderBy(aiGeneration.articleId, desc(aiGeneration.startedAt), desc(aiGeneration.createdAt));
  return new Map(rows.map((r) => [r.articleId, r]));
}

export async function latestGeneration(siteId: string, articleId: string, formatKind: string, db: Executor = getDb()): Promise<AiGenerationRow | null> {
  return (await latestGenerations(siteId, [articleId], formatKind, db)).get(articleId) ?? null;
}

export async function nextRevisionNumber(tx: Tx, siteId: string, articleId: string): Promise<number> {
  const [row] = await tx
    .select({ max: sql<number | null>`max(${articleRevision.number})` })
    .from(articleRevision)
    .where(and(eq(articleRevision.siteId, siteId), eq(articleRevision.articleId, articleId)));
  return Number(row?.max ?? 0) + 1;
}

/** All articles of the site with their current revision (newest updatedAt first). */
export async function listArticlesWithRevision(siteId: string, db: Executor = getDb()) {
  return db
    .select({ article, revision: articleRevision })
    .from(article)
    .leftJoin(articleRevision, and(eq(articleRevision.id, article.currentRevisionId), eq(articleRevision.siteId, siteId)))
    .where(eq(article.siteId, siteId))
    .orderBy(desc(article.updatedAt), desc(article.createdAt));
}
