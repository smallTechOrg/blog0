import 'server-only';

import { and, asc, count, desc, eq, inArray, max, ne, sql } from 'drizzle-orm';

import type { IssueEventKind, IssueStatus } from '@/lib/api/dto';

import type { Executor } from '../../db/client';
import { appUser, newsletterIssue, newsletterIssueEvent, newsletterMessage, type NewsletterIssueEventRow, type NewsletterIssueRow } from '../../db/schema';

// Row-level access for newsletter issues (spec/data.md newsletter_issue / newsletter_issue_event).
// Every function takes an Executor so transactions pass `tx`; every query filters by site.

export async function findIssue(db: Executor, siteId: string, id: string, lock = false): Promise<NewsletterIssueRow | null> {
  const q = db
    .select()
    .from(newsletterIssue)
    .where(and(eq(newsletterIssue.siteId, siteId), eq(newsletterIssue.id, id)))
    .limit(1);
  const [row] = lock ? await q.for('update') : await q;
  return row ?? null;
}

export async function listIssueRows(db: Executor, siteId: string, status?: IssueStatus): Promise<NewsletterIssueRow[]> {
  const where = [eq(newsletterIssue.siteId, siteId)];
  if (status) where.push(eq(newsletterIssue.status, status));
  return db
    .select()
    .from(newsletterIssue)
    .where(and(...where))
    .orderBy(desc(newsletterIssue.createdAt), desc(newsletterIssue.number));
}

/** `max(number) + 1` — call under the site row lock so two creations never collide. */
export async function nextIssueNumber(db: Executor, siteId: string): Promise<number> {
  const [row] = await db.select({ n: max(newsletterIssue.number) }).from(newsletterIssue).where(eq(newsletterIssue.siteId, siteId));
  return Number(row?.n ?? 0) + 1;
}

export type NewIssue = typeof newsletterIssue.$inferInsert;

export async function insertIssue(db: Executor, values: NewIssue): Promise<NewsletterIssueRow> {
  const [row] = await db.insert(newsletterIssue).values(values).returning();
  return row;
}

export async function updateIssueRow(db: Executor, id: string, set: Partial<Omit<NewsletterIssueRow, 'id' | 'siteId' | 'createdAt'>>): Promise<NewsletterIssueRow> {
  const [row] = await db
    .update(newsletterIssue)
    .set({ ...set, updatedAt: set.updatedAt ?? new Date() })
    .where(eq(newsletterIssue.id, id))
    .returning();
  if (!row) throw new Error(`newsletter_issue ${id} vanished during update`);
  return row;
}

export async function deleteIssueRow(db: Executor, id: string): Promise<void> {
  // Test messages keep their row (an audit of what was mailed) but lose the link to the deleted draft.
  await db.update(newsletterMessage).set({ issueId: null }).where(and(eq(newsletterMessage.issueId, id), eq(newsletterMessage.kind, 'test_issue')));
  await db.delete(newsletterIssue).where(eq(newsletterIssue.id, id));
}

export async function appendIssueEvent(
  db: Executor,
  event: { siteId: string; issueId: string; kind: IssueEventKind; actorUserId?: string | null; details?: Record<string, unknown>; createdAt?: Date },
): Promise<NewsletterIssueEventRow> {
  const [row] = await db
    .insert(newsletterIssueEvent)
    .values({ siteId: event.siteId, issueId: event.issueId, kind: event.kind, actorUserId: event.actorUserId ?? null, details: event.details ?? {}, createdAt: event.createdAt })
    .returning();
  return row;
}

export async function issueEvents(db: Executor, issueId: string): Promise<NewsletterIssueEventRow[]> {
  return db
    .select()
    .from(newsletterIssueEvent)
    .where(eq(newsletterIssueEvent.issueId, issueId))
    .orderBy(asc(newsletterIssueEvent.createdAt), asc(newsletterIssueEvent.id));
}

/** id → display name for the actors shown in a detail view. */
export async function userNames(db: Executor, ids: Array<string | null>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((v): v is string => v !== null))];
  if (unique.length === 0) return new Map();
  const rows = await db.select({ id: appUser.id, name: appUser.displayName }).from(appUser).where(inArray(appUser.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Every article id already in an automatic (per_post / digest) issue of the site. */
export async function automaticArticleIds(db: Executor, siteId: string): Promise<Set<string>> {
  const rows = await db
    .select({ ids: newsletterIssue.articleIds })
    .from(newsletterIssue)
    .where(and(eq(newsletterIssue.siteId, siteId), ne(newsletterIssue.origin, 'manual')));
  return new Set(rows.flatMap((r) => r.ids));
}

/** When the newest digest issue was created (the digest window's anchor), or null. */
export async function lastDigestIssueAt(db: Executor, siteId: string): Promise<Date | null> {
  const [row] = await db
    .select({ at: max(newsletterIssue.createdAt) })
    .from(newsletterIssue)
    .where(and(eq(newsletterIssue.siteId, siteId), eq(newsletterIssue.origin, 'digest')));
  const at = row?.at as Date | string | null | undefined;
  return at ? new Date(at) : null;
}

/** `kind: 'issue'` deliveries recorded for an issue (the stub sender's rows). */
export async function issueMessageCount(db: Executor, issueId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(newsletterMessage)
    .where(and(eq(newsletterMessage.issueId, issueId), eq(newsletterMessage.kind, 'issue')));
  return Number(row?.n ?? 0);
}

/** Issues sent since `since` that have a provider campaign (the tick refreshes their stats). */
export async function recentlySentIssues(db: Executor, siteId: string, since: Date): Promise<NewsletterIssueRow[]> {
  return db
    .select()
    .from(newsletterIssue)
    .where(
      and(
        eq(newsletterIssue.siteId, siteId),
        eq(newsletterIssue.status, 'sent'),
        sql`${newsletterIssue.providerCampaignId} is not null`,
        sql`${newsletterIssue.sentAt} >= ${since.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(desc(newsletterIssue.sentAt));
}
