// Newsletter E2E helpers (capabilities newsletter-list, newsletter-issues): what the stub mail
// transport and the stub sender recorded, read back by the walks.
//
// Main E2E (Postgres, blog0_test): the `newsletter_message` row IS the delivery under the stub
// transport (spec/architecture.md §13.2), so the confirm / unsubscribe links come from that table —
// exact per address, independent of log timing, and it works against an external server too.
// Designer E2E (PGlite, single process — no second DB client): the stub's `newsletter.mail` log line
// carries `confirm_url` in clear; it is read from the dev server's console file.
import { existsSync, readFileSync } from 'node:fs';

import { expect } from '@playwright/test';

import { withTestDb } from './db';

export const NL_DONE = 'Almost there — check your inbox and confirm.';
export const NL_CONFIRMED = 'You’re subscribed.';
export const NL_EXPIRED = 'This link has expired or was already used.';
export const NL_UNSUBSCRIBED = 'You’re unsubscribed. Sorry to see you go.';

const CONFIRM_RE = /https?:\/\/[^\s"'<>]+\/newsletter\/confirm\?t=[A-Za-z0-9_%-]+/;
const UNSUBSCRIBE_RE = /https?:\/\/[^\s"'<>]+\/newsletter\/unsubscribe\?t=[A-Za-z0-9_.%-]+/;

/** `/newsletter/confirm?t=…` of an absolute link (the server's public base may differ from baseURL). */
export function pathOf(url: string): string {
  const u = new URL(url);
  return u.pathname + u.search;
}

export function confirmUrlIn(body: string): string | null {
  return CONFIRM_RE.exec(body)?.[0] ?? null;
}

export function unsubscribeUrlIn(body: string): string | null {
  return UNSUBSCRIBE_RE.exec(body)?.[0] ?? null;
}

export interface MessageRow {
  id: string;
  kind: 'confirmation' | 'test_issue' | 'issue';
  to_email: string;
  subject: string;
  html: string;
  text: string;
  transport: string;
  status: string;
  issue_id: string | null;
  subscriber_id: string | null;
}

/** Every recorded message to `email` of `kind`, oldest first. */
export async function messagesTo(email: string, kind: MessageRow['kind']): Promise<MessageRow[]> {
  return withTestDb(
    (sql) => sql<MessageRow[]>`
      select id, kind, to_email, subject, html, text, transport, status, issue_id, subscriber_id
      from newsletter_message where to_email = ${email} and kind = ${kind}
      order by created_at, id`,
  );
}

/** The confirm link of the newest confirmation message to `email` (polled: the row commits with the 200). */
export async function latestConfirmUrl(email: string, after = 0): Promise<string> {
  let url: string | null = null;
  await expect
    .poll(
      async () => {
        const rows = await messagesTo(email, 'confirmation');
        url = rows.length > after ? confirmUrlIn(rows.at(-1)!.text) : null;
        return url;
      },
      { message: `confirmation message #${after + 1} to ${email} in newsletter_message` },
    )
    .not.toBeNull();
  return url!;
}

export interface SubscriberRow {
  id: string;
  status: string;
  signup_ip: string | null;
  signup_user_agent: string | null;
  signup_source_url: string | null;
  consent_text: string | null;
  consent_version: string | null;
}

export async function subscriberByEmail(email: string): Promise<SubscriberRow> {
  const rows = await withTestDb(
    (sql) => sql<SubscriberRow[]>`
      select id, status, signup_ip, signup_user_agent, signup_source_url, consent_text, consent_version
      from newsletter_subscriber where email = ${email}`,
  );
  expect(rows, `one newsletter_subscriber row for ${email}`).toHaveLength(1);
  return rows[0];
}

export async function eventKinds(subscriberId: string): Promise<string[]> {
  const rows = await withTestDb(
    (sql) => sql<{ kind: string }[]>`
      select kind from newsletter_subscriber_event where subscriber_id = ${subscriberId} order by created_at, id`,
  );
  return rows.map((r) => r.kind);
}

export async function suppressionRows(subscriberId: string): Promise<Array<{ reason: string; source: string }>> {
  return withTestDb(
    (sql) => sql<Array<{ reason: string; source: string }>>`
      select reason, source from newsletter_suppression where subscriber_id = ${subscriberId} order by created_at, id`,
  );
}

export async function confirmedCount(): Promise<number> {
  const [row] = await withTestDb((sql) => sql<{ n: number }[]>`select count(*)::int as n from newsletter_subscriber where status = 'confirmed'`);
  return row.n;
}

/**
 * A pre-double-opt-in subscriber as the 0002 migration leaves one (status `legacy_unconfirmed`,
 * source `legacy`, no consent of its own) — the state the admin's one-time confirmation is for.
 */
export async function insertLegacySubscriber(email: string, name: string | null = null): Promise<string> {
  const [row] = await withTestDb(
    (sql) => sql<{ id: string }[]>`
      insert into newsletter_subscriber (site_id, email, name, status, source)
      select id, ${email}, ${name}, 'legacy_unconfirmed', 'legacy' from site order by created_at limit 1
      returning id`,
  );
  return row.id;
}

/** The `confirm_url` of the newest stub `newsletter.mail` confirmation line in a server console/log file. */
export function confirmUrlFromLog(file: string, skipLines = 0): string | null {
  if (!existsSync(file)) return null;
  const lines = readFileSync(file, 'utf8').split('\n').slice(skipLines);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const l = lines[i].trim();
    if (!l.startsWith('{') || !l.includes('"newsletter.mail"')) continue;
    try {
      const parsed = JSON.parse(l) as { event?: string; kind?: string; confirm_url?: unknown };
      if (parsed.event === 'newsletter.mail' && parsed.kind === 'confirmation' && typeof parsed.confirm_url === 'string') return parsed.confirm_url;
    } catch {
      // a partially written line — the next poll reads it whole
    }
  }
  return null;
}

/** How many lines `file` has now (a cursor for confirmUrlFromLog). */
export function lineCount(file: string): number {
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').length - 1 : 0;
}
