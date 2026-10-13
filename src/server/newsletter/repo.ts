import 'server-only';

import { and, asc, count, desc, eq, gte, ilike, sql } from 'drizzle-orm';

import type { SubscriberCounts, SubscriberStatus } from '@/lib/api/dto';

import type { Executor } from '../db/client';
import {
  newsletterMessage,
  newsletterSubscriber,
  newsletterSubscriberEvent,
  newsletterSuppression,
  type NewsletterMessageRow,
  type NewsletterSubscriberEventRow,
  type NewsletterSubscriberRow,
  type NewsletterSuppressionRow,
} from '../db/schema';

// Row-level access for the owned list (spec/data.md). Every function takes an Executor so a
// transaction passes `tx` (PGlite deadlocks on the outer handle inside a transaction — §11.3) and
// every query filters by site.

export type NewEvent = Omit<NewsletterSubscriberEventRow, 'id' | 'createdAt' | 'details'> & {
  details?: Record<string, unknown>;
  createdAt?: Date;
};
export type NewSuppression = Omit<NewsletterSuppressionRow, 'id' | 'createdAt' | 'details'> & { details?: Record<string, unknown>; createdAt?: Date };

export async function findByEmail(db: Executor, siteId: string, email: string, lock = false): Promise<NewsletterSubscriberRow | null> {
  const q = db
    .select()
    .from(newsletterSubscriber)
    .where(and(eq(newsletterSubscriber.siteId, siteId), eq(newsletterSubscriber.email, email)))
    .limit(1);
  const [row] = lock ? await q.for('update') : await q;
  return row ?? null;
}

export async function findById(db: Executor, siteId: string, id: string, lock = false): Promise<NewsletterSubscriberRow | null> {
  const q = db
    .select()
    .from(newsletterSubscriber)
    .where(and(eq(newsletterSubscriber.siteId, siteId), eq(newsletterSubscriber.id, id)))
    .limit(1);
  const [row] = lock ? await q.for('update') : await q;
  return row ?? null;
}

export async function findByTokenHash(db: Executor, siteId: string, hash: string): Promise<NewsletterSubscriberRow | null> {
  const [row] = await db
    .select()
    .from(newsletterSubscriber)
    .where(and(eq(newsletterSubscriber.siteId, siteId), eq(newsletterSubscriber.confirmTokenHash, hash)))
    .limit(1);
  return row ?? null;
}

export async function updateSubscriber(
  db: Executor,
  id: string,
  set: Partial<Omit<NewsletterSubscriberRow, 'id' | 'siteId' | 'createdAt'>>,
): Promise<NewsletterSubscriberRow> {
  const [row] = await db.update(newsletterSubscriber).set(set).where(eq(newsletterSubscriber.id, id)).returning();
  if (!row) throw new Error(`newsletter_subscriber ${id} vanished during update`);
  return row;
}

export async function appendEvent(db: Executor, event: NewEvent): Promise<NewsletterSubscriberEventRow> {
  const [row] = await db
    .insert(newsletterSubscriberEvent)
    .values({ ...event, details: event.details ?? {} })
    .returning();
  return row;
}

export async function appendSuppression(db: Executor, suppression: NewSuppression): Promise<NewsletterSuppressionRow> {
  const [row] = await db
    .insert(newsletterSuppression)
    .values({ ...suppression, details: suppression.details ?? {} })
    .returning();
  return row;
}

export async function eventsOf(db: Executor, subscriberId: string): Promise<NewsletterSubscriberEventRow[]> {
  return db
    .select()
    .from(newsletterSubscriberEvent)
    .where(eq(newsletterSubscriberEvent.subscriberId, subscriberId))
    .orderBy(asc(newsletterSubscriberEvent.createdAt), asc(newsletterSubscriberEvent.id));
}

export async function suppressionsOf(db: Executor, siteId: string, email: string): Promise<NewsletterSuppressionRow[]> {
  return db
    .select()
    .from(newsletterSuppression)
    .where(and(eq(newsletterSuppression.siteId, siteId), eq(newsletterSuppression.email, email)))
    .orderBy(asc(newsletterSuppression.createdAt), asc(newsletterSuppression.id));
}

export async function hasSuppression(db: Executor, subscriberId: string): Promise<boolean> {
  const [row] = await db.select({ n: count() }).from(newsletterSuppression).where(eq(newsletterSuppression.subscriberId, subscriberId));
  return Number(row?.n ?? 0) > 0;
}

export async function messagesOf(db: Executor, subscriberId: string): Promise<NewsletterMessageRow[]> {
  return db
    .select()
    .from(newsletterMessage)
    .where(eq(newsletterMessage.subscriberId, subscriberId))
    .orderBy(asc(newsletterMessage.createdAt), asc(newsletterMessage.id));
}

/** `confirmation_sent` + `legacy_confirmation_sent` events in the window ending at `now` (the 3-per-24 h cap). */
export async function confirmationSendsSince(db: Executor, subscriberId: string, since: Date): Promise<{ n: number; oldest: Date | null }> {
  const rows = await db
    .select({ createdAt: newsletterSubscriberEvent.createdAt })
    .from(newsletterSubscriberEvent)
    .where(
      and(
        eq(newsletterSubscriberEvent.subscriberId, subscriberId),
        gte(newsletterSubscriberEvent.createdAt, since),
        sql`${newsletterSubscriberEvent.kind} in ('confirmation_sent', 'legacy_confirmation_sent')`,
        sql`coalesce(${newsletterSubscriberEvent.details} ->> 'outcome', 'sent') <> 'failed'`,
      ),
    )
    .orderBy(asc(newsletterSubscriberEvent.createdAt));
  return { n: rows.length, oldest: rows[0]?.createdAt ?? null };
}

/** A used confirm token: its hash is kept in the `confirmed` / `resubscribed` event (so a second click can answer "already used"). */
export async function wasTokenUsed(db: Executor, siteId: string, hash: string): Promise<boolean> {
  const [row] = await db
    .select({ n: count() })
    .from(newsletterSubscriberEvent)
    .where(
      and(
        eq(newsletterSubscriberEvent.siteId, siteId),
        sql`${newsletterSubscriberEvent.kind} in ('confirmed', 'resubscribed')`,
        sql`${newsletterSubscriberEvent.details} ->> 'tokenHash' = ${hash}`,
      ),
    );
  return Number(row?.n ?? 0) > 0;
}

export interface ListFilter {
  status?: SubscriberStatus;
  q?: string;
}

export async function listRows(db: Executor, siteId: string, filter: ListFilter = {}): Promise<NewsletterSubscriberRow[]> {
  const where = [eq(newsletterSubscriber.siteId, siteId)];
  if (filter.status) where.push(eq(newsletterSubscriber.status, filter.status));
  if (filter.q) where.push(ilike(newsletterSubscriber.email, `%${filter.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`));
  return db
    .select()
    .from(newsletterSubscriber)
    .where(and(...where))
    .orderBy(desc(newsletterSubscriber.createdAt), desc(newsletterSubscriber.email));
}

export async function countsOf(db: Executor, siteId: string): Promise<SubscriberCounts> {
  const rows = await db
    .select({ status: newsletterSubscriber.status, n: count() })
    .from(newsletterSubscriber)
    .where(eq(newsletterSubscriber.siteId, siteId))
    .groupBy(newsletterSubscriber.status);
  const counts: SubscriberCounts = { all: 0, pending: 0, confirmed: 0, unsubscribed: 0, bounced: 0, legacy_unconfirmed: 0 };
  for (const r of rows) {
    const n = Number(r.n);
    counts[r.status] = n;
    counts.all += n;
  }
  return counts;
}

export async function allEvents(db: Executor, siteId: string): Promise<NewsletterSubscriberEventRow[]> {
  return db
    .select()
    .from(newsletterSubscriberEvent)
    .where(eq(newsletterSubscriberEvent.siteId, siteId))
    .orderBy(asc(newsletterSubscriberEvent.createdAt), asc(newsletterSubscriberEvent.id));
}

export async function allSuppressions(db: Executor, siteId: string): Promise<NewsletterSuppressionRow[]> {
  return db
    .select()
    .from(newsletterSuppression)
    .where(eq(newsletterSuppression.siteId, siteId))
    .orderBy(asc(newsletterSuppression.createdAt), asc(newsletterSuppression.id));
}

/** Candidates for the 12-month IP prune: still holding an IP, past the retention bar. */
export async function pruneCandidates(db: Executor, siteId: string, bar: Date): Promise<NewsletterSubscriberRow[]> {
  return db
    .select()
    .from(newsletterSubscriber)
    .where(
      and(
        eq(newsletterSubscriber.siteId, siteId),
        sql`(${newsletterSubscriber.signupIp} is not null or ${newsletterSubscriber.confirmedIp} is not null)`,
        sql`coalesce(${newsletterSubscriber.confirmedAt}, ${newsletterSubscriber.createdAt}) < ${bar.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(asc(newsletterSubscriber.createdAt));
}
