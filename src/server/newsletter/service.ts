import 'server-only';

import { count, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { getDb } from '../db/client';
import { newsletterSubscriber } from '../db/schema';
import type { SubscriberDto, SubscriberListResponse } from '@/lib/api/dto';

// Newsletter signup (capability newsletter-signup). Emails are trimmed + lower-cased; a repeat
// signup for the same (site, email) succeeds silently — the caller cannot tell whether the address
// already existed — re-activates the row and updates the name when one is given.

export const EMAIL_MAX = 254;
export const NAME_MAX = 120;

export const subscribeBody = z.object({
  email: z.string().trim().toLowerCase().max(EMAIL_MAX).pipe(z.email()),
  name: z
    .string()
    .trim()
    .max(NAME_MAX)
    .nullish()
    .transform((v) => (v ? v : null)),
});

export type SubscribeInput = z.infer<typeof subscribeBody>;

/** Upserts the subscriber for `siteId` (unique on site_id + email). */
export async function subscribe(siteId: string, input: SubscribeInput, source = 'footer'): Promise<void> {
  const now = new Date();
  await getDb()
    .insert(newsletterSubscriber)
    .values({ siteId, email: input.email, name: input.name, source, status: 'subscribed', createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [newsletterSubscriber.siteId, newsletterSubscriber.email],
      set: {
        name: sql`coalesce(excluded.name, ${newsletterSubscriber.name})`,
        status: 'subscribed',
        updatedAt: now,
      },
    });
}

/** Every subscriber of the site, newest first. */
export async function listSubscribers(siteId: string): Promise<SubscriberListResponse> {
  const db = getDb();
  const rows = await db
    .select({
      email: newsletterSubscriber.email,
      name: newsletterSubscriber.name,
      createdAt: newsletterSubscriber.createdAt,
      status: newsletterSubscriber.status,
    })
    .from(newsletterSubscriber)
    .where(eq(newsletterSubscriber.siteId, siteId))
    .orderBy(desc(newsletterSubscriber.createdAt), desc(newsletterSubscriber.email));
  const [{ n }] = await db
    .select({ n: count() })
    .from(newsletterSubscriber)
    .where(eq(newsletterSubscriber.siteId, siteId));
  const subscribers: SubscriberDto[] = rows.map((r) => ({
    email: r.email,
    name: r.name,
    createdAt: r.createdAt.toISOString(),
    status: r.status,
  }));
  return { subscribers, total: Number(n) };
}

/* CSV (RFC 4180) with spreadsheet-formula neutralising: a cell starting with = + - @ or a
   tab/CR is prefixed with an apostrophe so opening the export never runs a formula. */
function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export const CSV_HEADER = ['email', 'name', 'subscribed_at', 'status'] as const;

export function subscribersToCsv(subscribers: SubscriberDto[]): string {
  const lines = [CSV_HEADER.join(',')];
  for (const s of subscribers) {
    lines.push([s.email, s.name ?? '', s.createdAt, s.status].map(csvCell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
