// Erasure at the database level, on BOTH engines (PostgreSQL = the test database, PGlite = an
// in-memory instance). Owner decision 2026-10-19 (migration 0005_newsletter_erase_delete):
// `newsletter_erase_subscriber(id, erased_by, source)` DELETES the subscriber and every row holding its
// data (events, suppressions, messages, earlier 0004 tombstones of the same address), keeps only the
// keyed-hash marker and one PII-free audit row, keeps issue counts intact, and the append-only guards
// stay shut for everything else. Erase → re-subscribe → confirm → erase works (the 0004 bug: 23505 on
// newsletter_subscriber_site_email_unique). Also: migration 0004 on a 0003 database, and migration
// 0005 repairing 0004 tombstones. Same SQL, same assertions, two engines.
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDb, createDbHandle, rowsOf, type DbHandle } from '@/server/db/client';
import { MIGRATIONS_FOLDER, getMigrationStatus, readJournal, runMigrations } from '@/server/db/migrate';
import { openPglite } from '@/server/db/pglite';
import { DEFAULT_PRIVACY_TEXT } from '@/server/db/schema';
import { erasureHash } from '@/server/newsletter/tokens';

import { getTestDatabaseUrl } from '../helpers/env';

type Engine = 'postgres' | 'pglite';

const EMAIL = 'erase.me@example.com';
const IP = '203.0.113.77';
const UA = 'EraseTest/9.9 (secret-agent-string)';
const SOURCE_PII = '/p/erase-me-source-page';
const NAME_PII = 'Erase Me Person';
const TOKEN_PII = 'TOKENabcDEF123_-TOKENabcDEF123_-TOKENabcDEF12';
const TOKEN = TOKEN_PII;
const PII = [EMAIL, IP, UA, SOURCE_PII, NAME_PII, 'Erase.Me', TOKEN_PII];
const BYSTANDER: ReaderTraits = { ip: '198.51.100.5', ua: 'Bystander/1.0', name: 'By Stander', source: '/p/bystander', token: 'BYSTANDERtoken0123456789_-BYSTANDERtoken0123' };
const NEWSLETTER_TABLES = [
  'newsletter_subscriber',
  'newsletter_subscriber_event',
  'newsletter_suppression',
  'newsletter_message',
  'newsletter_issue',
  'newsletter_issue_event',
  'newsletter_erasure_marker',
  'newsletter_erasure_log',
];

async function run<T = Record<string, unknown>>(handle: DbHandle, text: string): Promise<T[]> {
  return rowsOf<T>(await handle.db.execute(sql.raw(text)));
}

/** Runs a statement expecting it to raise; returns the error text ('' when it passed). */
async function refusal(handle: DbHandle, text: string): Promise<string> {
  try {
    await handle.db.execute(sql.raw(text));
  } catch (err) {
    const e = err as Error & { cause?: Error };
    return `${e.message} ${e.cause?.message ?? ''}`;
  }
  return '';
}

async function dump(handle: DbHandle, table: string, where = 'true'): Promise<string> {
  const rows = await run<{ j: string }>(handle, `select to_jsonb(t)::text as j from ${table} t where ${where}`);
  return rows.map((r) => r.j).join('\n');
}

/** Every newsletter table of a site, as one lower-cased blob. */
async function siteBlob(handle: DbHandle, siteId: string): Promise<string> {
  const parts = await Promise.all(NEWSLETTER_TABLES.map((t) => dump(handle, t, `site_id = '${siteId}'`)));
  return parts.join('\n').toLowerCase();
}

function sqlText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function newSite(handle: DbHandle): Promise<{ id: string; salt: string }> {
  const [site] = await run<{ id: string; newsletter_erase_salt: string }>(
    handle,
    `insert into site (slug, brand_name, wordmark, publisher_name, tagline, contact_email, about_strap, about_stand, about_body_md)
     values ('erasure-${Math.random().toString(36).slice(2)}', 'blog0', 'blog0', 'smallTech', 't', 'hello@example.com', 's', 's', 'b')
     returning id, newsletter_erase_salt`,
  );
  return { id: site.id, salt: site.newsletter_erase_salt };
}

async function newIssue(handle: DbHandle, siteId: string, number: number): Promise<string> {
  const [issue] = await run<{ id: string }>(
    handle,
    `insert into newsletter_issue (site_id, number, status, origin, title, posts, article_ids, recipient_count, stats, sent_at)
     values ('${siteId}', ${number}, 'sent', 'manual', 'Issue ${number}', '[]'::jsonb, '{}'::uuid[], 2, '{"recipients":2,"sent":2}'::jsonb, now()) returning id`,
  );
  return issue.id;
}

/** A confirmed subscriber with the full footprint of a once-unsubscribed reader (events, suppression, messages incl. one issue delivery). */
let seq = 0;
interface ReaderTraits {
  ip?: string;
  ua?: string;
  name?: string;
  source?: string;
  token?: string;
}

/** The erased reader carries the PII constants; anyone else passes traits of their own. */
async function addReader(handle: DbHandle, siteId: string, email: string, issueId: string, opts: ReaderTraits = {}): Promise<string> {
  seq += 1;
  const ip = opts.ip ?? IP;
  const ua = opts.ua ?? UA;
  const NAME = opts.name ?? NAME_PII;
  const SOURCE_URL = opts.source ?? SOURCE_PII;
  const TOKEN = opts.token ?? TOKEN_PII;
  const [sub] = await run<{ id: string }>(
    handle,
    `insert into newsletter_subscriber (site_id, email, name, status, signup_source_url, signup_ip, signup_user_agent, consent_text, consent_version, consented_at,
        confirm_token_hash, confirm_token_expires_at, confirmed_at, confirmed_ip, confirmed_user_agent, provider_id)
     values ('${siteId}', '${email}', '${NAME}', 'confirmed', '${SOURCE_URL}', '${ip}', ${sqlText(ua)}, 'One issue a week.', 'v1', now(),
        'hash-of-${TOKEN}-${seq}', now() + interval '1 day', now(), '${ip}', ${sqlText(ua)}, 'provider-${seq}') returning id`,
  );
  await run(
    handle,
    `insert into newsletter_subscriber_event (site_id, subscriber_id, email, kind, source, ip, user_agent, details) values
     ('${siteId}', '${sub.id}', '${email}', 'signup', 'footer', '${ip}', ${sqlText(ua)}, '{"sourceUrl":"${SOURCE_URL}","note":"${email}"}'::jsonb),
     ('${siteId}', '${sub.id}', '${email}', 'confirmed', 'email_link', '${ip}', ${sqlText(ua)}, '{"tokenHash":"hash-of-${TOKEN}-${seq}"}'::jsonb),
     ('${siteId}', '${sub.id}', '${email}', 'unsubscribed', 'one_click', '${ip}', ${sqlText(ua)}, '{"reason":"unsubscribed"}'::jsonb)`,
  );
  await run(
    handle,
    `insert into newsletter_suppression (site_id, subscriber_id, email, reason, source, details)
     values ('${siteId}', '${sub.id}', '${email}', 'unsubscribed', 'one_click', '{"note":"${email} asked"}'::jsonb)`,
  );
  await run(
    handle,
    `insert into newsletter_message (site_id, kind, subscriber_id, issue_id, to_email, subject, html, "text", transport, status, error) values
     ('${siteId}', 'confirmation', '${sub.id}', null, '${email}', 'Confirm ${email}', '<a href="http://x/newsletter/confirm?t=[redacted]">${email}</a>', 'Hi ${email}', 'smtp', 'failed', '550 no such user ${email}'),
     ('${siteId}', 'issue', '${sub.id}', '${issueId}', '${email}', 'Issue 1', '<p>Hi ${email}</p>', 'Hi ${email}', 'stub', 'stubbed', null)`,
  );
  return sub.id;
}

async function seed(handle: DbHandle) {
  const site = await newSite(handle);
  const issueId = await newIssue(handle, site.id, 1);
  const a = await addReader(handle, site.id, EMAIL, issueId);
  const b = await addReader(handle, site.id, 'bystander@example.com', issueId, BYSTANDER);
  const [user] = await run<{ id: string }>(
    handle,
    `insert into app_user (site_id, email, display_name, password_hash) values ('${site.id}', 'desk-${seq}@example.test', 'Desk', 'x') returning id`,
  );
  return { siteId: site.id, salt: site.salt, issueId, a, b, userId: user.id };
}

interface EraseResult {
  erased: boolean;
  erasureId?: string;
  subscribers?: number;
  events?: number;
  messages?: number;
  suppressions?: number;
}

async function erase(handle: DbHandle, id: string, by: string | null = null): Promise<EraseResult> {
  const [row] = await run<{ r: EraseResult | string }>(handle, `select newsletter_erase_subscriber('${id}'::uuid, ${by ? `'${by}'::uuid` : 'null'}) as r`);
  return typeof row.r === 'string' ? (JSON.parse(row.r) as EraseResult) : row.r;
}

async function count(handle: DbHandle, table: string, where: string): Promise<number> {
  const [row] = await run<{ n: string | number }>(handle, `select count(*) as n from ${table} where ${where}`);
  return Number(row.n);
}

function engineSuite(engine: Engine) {
  describe(`newsletter_erase_subscriber on ${engine}`, () => {
    let handle: DbHandle;

    beforeAll(async () => {
      if (engine === 'pglite') {
        handle = await openPglite('memory');
        await runMigrations(handle);
      } else {
        const url = getTestDatabaseUrl();
        await closeDb();
        // one connection: the hand-raised `set_config(..., false)` below is session-level
        handle = await createDbHandle({ engine: 'postgres', url }, { max: 1 });
      }
    });

    afterAll(async () => {
      await handle?.close();
    });

    it('deletes the subscriber and every row holding its data; only the hashed marker and a PII-free audit row remain; issue counts and the bystander are untouched', async () => {
      const s = await seed(handle);
      const bystanderBefore = await Promise.all(
        ['newsletter_subscriber', 'newsletter_subscriber_event', 'newsletter_suppression', 'newsletter_message'].map((t) =>
          dump(handle, t, t === 'newsletter_subscriber' ? `id = '${s.b}'` : `subscriber_id = '${s.b}'`),
        ),
      );
      expect(await siteBlob(handle, s.siteId)).toContain(EMAIL); // the scan would catch it

      const result = await erase(handle, s.a, s.userId);

      expect(result).toMatchObject({ erased: true, subscribers: 1, events: 3, messages: 2, suppressions: 1 });
      expect(result.erasureId).toMatch(/^[0-9a-f-]{36}$/);

      // 1. no newsletter table of the site holds the address, IP, user agent, name, source URL or token
      const blob = await siteBlob(handle, s.siteId);
      for (const needle of PII) expect(blob, `still contains ${needle}`).not.toContain(needle.toLowerCase());
      expect(blob).not.toContain('erased.invalid'); // no tombstone either

      // 2. the rows are gone, not redacted
      expect(await count(handle, 'newsletter_subscriber', `id = '${s.a}'`)).toBe(0);
      for (const t of ['newsletter_subscriber_event', 'newsletter_suppression', 'newsletter_message']) expect(await count(handle, t, `subscriber_id = '${s.a}'`), t).toBe(0);

      // 3. the marker: keyed hash of the address, nothing else
      const hash = erasureHash(s.salt, EMAIL);
      const markers = await run<Record<string, unknown>>(handle, `select * from newsletter_erasure_marker where site_id = '${s.siteId}'`);
      expect(markers).toHaveLength(1);
      expect(markers[0]).toMatchObject({ email_hash: hash });
      expect(Object.keys(markers[0]).sort()).toEqual(['created_at', 'email_hash', 'site_id']);

      // 4. the audit row: who/when/which marker/how many rows; provider step still to come
      const [log] = await run<Record<string, unknown>>(handle, `select * from newsletter_erasure_log where id = '${result.erasureId}'`);
      expect(log).toMatchObject({
        site_id: s.siteId,
        email_hash: hash,
        source: 'admin',
        erased_by: s.userId,
        provider_outcome: 'pending',
        provider_ref: null,
        details: { subscribers: 1, events: 3, messages: 2, suppressions: 1 },
      });

      // 5. the issue keeps its numbers: the deleted delivery is counted on the issue
      const [issue] = await run<{ erased_message_count: number; recipient_count: number }>(handle, `select erased_message_count, recipient_count from newsletter_issue where id = '${s.issueId}'`);
      expect(issue).toEqual({ erased_message_count: 1, recipient_count: 2 });
      expect(await count(handle, 'newsletter_message', `issue_id = '${s.issueId}' and kind = 'issue'`) + issue.erased_message_count).toBe(2);

      // 6. the bystander is byte-for-byte the same
      const bystanderAfter = await Promise.all(
        ['newsletter_subscriber', 'newsletter_subscriber_event', 'newsletter_suppression', 'newsletter_message'].map((t) =>
          dump(handle, t, t === 'newsletter_subscriber' ? `id = '${s.b}'` : `subscriber_id = '${s.b}'`),
        ),
      );
      expect(bystanderAfter).toEqual(bystanderBefore);
      expect(bystanderAfter.join('')).toContain('bystander@example.com');
    });

    it('erase → re-subscribe (any casing) → confirm → erase again succeeds: one marker, two audit rows, nothing personal left', async () => {
      const s = await seed(handle);
      expect((await erase(handle, s.a)).erased).toBe(true);

      // the footer signup inserts a fresh pending row (allowed by the marker guard), the click confirms it
      const [again] = await run<{ id: string }>(
        handle,
        `insert into newsletter_subscriber (site_id, email, status, signup_ip, signup_user_agent) values ('${s.siteId}', ' Erase.Me@Example.COM ', 'pending', '${IP}', ${sqlText(UA)}) returning id`,
      );
      await run(handle, `insert into newsletter_subscriber_event (site_id, subscriber_id, email, kind, source, ip, user_agent, details) values ('${s.siteId}', '${again.id}', '${EMAIL}', 'signup', 'footer', '${IP}', ${sqlText(UA)}, '{"erasedBefore":true}'::jsonb)`);
      await run(handle, `update newsletter_subscriber set status = 'confirmed', confirmed_at = now(), confirmed_ip = '${IP}' where id = '${again.id}'`);

      const second = await erase(handle, again.id);
      expect(second).toMatchObject({ erased: true, subscribers: 1, events: 1 });

      expect(await count(handle, 'newsletter_erasure_marker', `site_id = '${s.siteId}'`)).toBe(1);
      expect(await count(handle, 'newsletter_erasure_log', `site_id = '${s.siteId}'`)).toBe(2);
      const blob = await siteBlob(handle, s.siteId);
      for (const needle of PII) expect(blob, `still contains ${needle}`).not.toContain(needle.toLowerCase());
    });

    it('the 0004 collision is gone: a live row next to an old tombstone of the same address erases cleanly and takes the tombstone with it', async () => {
      const s = await seed(handle);
      const hash = erasureHash(s.salt, EMAIL);
      const tomb = `erased+${hash}@erased.invalid`;
      // a leftover of the 0004 behaviour (what migration 0005 repairs on real databases)
      const [old] = await run<{ id: string }>(handle, `insert into newsletter_subscriber (site_id, email, status) values ('${s.siteId}', '${tomb}', 'unsubscribed') returning id`);
      await run(handle, `insert into newsletter_subscriber_event (site_id, subscriber_id, email, kind, source) values ('${s.siteId}', '${old.id}', '${tomb}', 'erased', 'admin')`);
      await run(handle, `insert into newsletter_suppression (site_id, subscriber_id, email, reason, source, email_hash) values ('${s.siteId}', '${old.id}', '${tomb}', 'erased', 'admin', '${hash}')`);

      const result = await erase(handle, s.a);

      expect(result).toMatchObject({ erased: true, subscribers: 2, events: 4, suppressions: 2 });
      expect(await count(handle, 'newsletter_subscriber', `site_id = '${s.siteId}' and email in ('${EMAIL}', '${tomb}')`)).toBe(0);
      expect(await count(handle, 'newsletter_erasure_marker', `site_id = '${s.siteId}' and email_hash = '${hash}'`)).toBe(1);
    });

    it('an unknown id returns {erased: false} and writes nothing', async () => {
      const s = await seed(handle);
      await erase(handle, s.a);
      const total = async () =>
        (await Promise.all(['newsletter_subscriber_event', 'newsletter_suppression', 'newsletter_erasure_log', 'newsletter_erasure_marker'].map((t) => count(handle, t, 'true')))).join(',');
      const before = await total();

      expect(await erase(handle, s.a)).toEqual({ erased: false });
      expect(await erase(handle, '00000000-0000-4000-8000-000000000000')).toEqual({ erased: false });

      expect(await total()).toBe(before);
    });

    it('the marker blocks silent re-adding: a direct insert (import, restore script) of the erased address in any status but pending raises; pending and other sites pass', async () => {
      const s = await seed(handle);
      await erase(handle, s.a);
      for (const status of ['confirmed', 'legacy_unconfirmed', 'unsubscribed', 'bounced']) {
        const text = `insert into newsletter_subscriber (site_id, email, status) values ('${s.siteId}', '  ${EMAIL.toUpperCase()} ', '${status}')`;
        const msg = await refusal(handle, text);
        expect(msg, status).toMatch(/was erased — it can only be re-added by a new double opt-in signup/);
        expect(msg).not.toContain(EMAIL);
      }
      // another site has its own salt and no marker for the address
      const other = await newSite(handle);
      expect(await refusal(handle, `insert into newsletter_subscriber (site_id, email, status) values ('${other.id}', '${EMAIL}', 'confirmed')`)).toBe('');
      // the double opt-in path: a pending row is allowed (and confirming it later is an UPDATE)
      expect(await refusal(handle, `insert into newsletter_subscriber (site_id, email, status) values ('${s.siteId}', '${EMAIL}', 'pending')`)).toBe('');
    });

    it('the ledger stays append-only; the erase exception covers only the ids being erased', async () => {
      const s = await seed(handle);
      await erase(handle, s.a);
      const [ev] = await run<{ id: string }>(handle, `select id from newsletter_subscriber_event where subscriber_id = '${s.b}' limit 1`);
      const [sup] = await run<{ id: string }>(handle, `select id from newsletter_suppression where subscriber_id = '${s.b}' limit 1`);

      const attempts = [
        `update newsletter_subscriber_event set email = 'x@example.com' where id = '${ev.id}'`,
        `update newsletter_subscriber_event set ip = null where id = '${ev.id}'`,
        `delete from newsletter_subscriber_event where id = '${ev.id}'`,
        `update newsletter_suppression set email = 'x@example.com' where id = '${sup.id}'`,
        `update newsletter_suppression set reason = 'admin' where id = '${sup.id}'`,
        `delete from newsletter_suppression where id = '${sup.id}'`,
      ];
      for (const text of attempts) expect(await refusal(handle, text), text).toMatch(/append-only/);

      // the 0004 redaction flag no longer opens anything; the 0005 id list only opens deletes of its own ids
      await run(handle, `select set_config('blog0.newsletter_erase', '1', false)`);
      await run(handle, `select set_config('blog0.newsletter_erase_ids', '00000000-0000-4000-8000-000000000000', false)`);
      try {
        for (const text of [
          `update newsletter_subscriber_event set email = 'erased+abc@erased.invalid', ip = null, user_agent = null, details = '{}'::jsonb where id = '${ev.id}'`,
          `delete from newsletter_subscriber_event where id = '${ev.id}'`,
          `delete from newsletter_suppression where id = '${sup.id}'`,
        ]) {
          expect(await refusal(handle, text), text).toMatch(/append-only/);
        }
      } finally {
        await run(handle, `select set_config('blog0.newsletter_erase', '0', false)`);
        await run(handle, `select set_config('blog0.newsletter_erase_ids', '', false)`);
      }
    });

    it('the erasure records are insert-only: a marker never changes or goes; an audit row only takes provider updates', async () => {
      const s = await seed(handle);
      const { erasureId } = await erase(handle, s.a);
      for (const text of [
        `update newsletter_erasure_marker set email_hash = 'x' where site_id = '${s.siteId}'`,
        `delete from newsletter_erasure_marker where site_id = '${s.siteId}'`,
        `delete from newsletter_erasure_log where id = '${erasureId}'`,
        `update newsletter_erasure_log set erased_at = now() - interval '1 day' where id = '${erasureId}'`,
        `update newsletter_erasure_log set details = '{}'::jsonb where id = '${erasureId}'`,
        `update newsletter_erasure_log set email_hash = 'x' where id = '${erasureId}'`,
      ]) {
        expect(await refusal(handle, text), text).toMatch(/append-only/);
      }
      expect(await refusal(handle, `update newsletter_erasure_log set provider_outcome = 'deleted', provider_ref = '42', provider_checked_at = now() where id = '${erasureId}'`)).toBe('');
      expect(await refusal(handle, `update newsletter_erasure_log set provider_outcome = 'gone' where id = '${erasureId}'`)).toMatch(/check/i);
    });

    it('the function is SECURITY DEFINER with a pinned search_path and the documented signature', async () => {
      const [fn] = await run<{ args: string; secdef: boolean; config: string[] | string | null; returns: string }>(
        handle,
        `select pg_get_function_identity_arguments(p.oid) as args, p.prosecdef as secdef, p.proconfig as config, pg_get_function_result(p.oid) as returns
         from pg_proc p where p.proname = 'newsletter_erase_subscriber'`,
      );
      expect(fn.args).toBe('p_subscriber_id uuid, p_erased_by uuid, p_source text');
      expect(fn.returns).toBe('jsonb');
      expect(fn.secdef).toBe(true);
      expect(JSON.stringify(fn.config)).toContain('search_path=');
      const s = await seed(handle);
      expect(await refusal(handle, `select newsletter_erase_subscriber('${s.a}'::uuid, null, 'robot')`)).toMatch(/unknown source/);
      expect(await count(handle, 'newsletter_subscriber', `id = '${s.a}'`)).toBe(1);
    });
  });
}

engineSuite('postgres');
engineSuite('pglite');

// --- migrations on databases that already hold data ----------------------------------------------

/** A copy of the migrations folder holding only entries with idx < `upTo`. */
function folderUpTo(upTo: number): string {
  const dir = mkdtempSync(path.join(tmpdir(), `blog0-mig${upTo}-`));
  cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
  const journal = readJournal(MIGRATIONS_FOLDER);
  for (const e of journal.filter((x) => x.idx >= upTo)) {
    rmSync(path.join(dir, `${e.tag}.sql`));
    rmSync(path.join(dir, 'meta', `${String(e.idx).padStart(4, '0')}_snapshot.json`), { force: true });
  }
  writeFileSync(path.join(dir, 'meta', '_journal.json'), JSON.stringify({ version: '7', dialect: 'postgresql', entries: journal.filter((e) => e.idx < upTo) }));
  return dir;
}

async function freshHandle(engine: Engine): Promise<DbHandle> {
  if (engine === 'pglite') return openPglite('memory');
  const url = getTestDatabaseUrl();
  await closeDb();
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe('drop schema if exists drizzle cascade; drop schema if exists public cascade; create schema public;');
  } finally {
    await admin.end({ timeout: 5 });
  }
  return createDbHandle({ engine: 'postgres', url }, { max: 1 });
}

const LATEST = readJournal(MIGRATIONS_FOLDER).at(-1)!.tag;
const TOTAL = readJournal(MIGRATIONS_FOLDER).length;

function migrationSuite(engine: Engine) {
  describe(`migration 0004_newsletter_erasure on a 0003 database (${engine})`, () => {
    it('adds the site columns (draft privacy text, empty address, a distinct random salt per existing site), redacts stored confirmation tokens only, and migrates to the latest', async () => {
      const dir = folderUpTo(4);
      const handle = await freshHandle(engine);
      try {
        await runMigrations(handle, dir);
        expect((await getMigrationStatus(handle, dir)).applied).toHaveLength(4);
        const siteIds: string[] = [];
        for (const slug of ['one', 'two']) {
          const [row] = await run<{ id: string }>(
            handle,
            `insert into site (slug, brand_name, wordmark, publisher_name, tagline, contact_email, about_strap, about_stand, about_body_md)
             values ('${slug}', 'b', 'b', 'p', 't', 'hello@example.com', 's', 's', 'b') returning id`,
          );
          siteIds.push(row.id);
        }
        const [sub] = await run<{ id: string }>(handle, `insert into newsletter_subscriber (site_id, email, status) values ('${siteIds[0]}', 'old@example.com', 'pending') returning id`);
        const link = `http://localhost:3410/newsletter/confirm?t=${TOKEN}`;
        await run(
          handle,
          `insert into newsletter_message (site_id, kind, subscriber_id, to_email, subject, html, "text", transport, status) values
           ('${siteIds[0]}', 'confirmation', '${sub.id}', 'old@example.com', 'Confirm', '<a href="${link}">${link}</a><a href="http://localhost:3410/newsletter/unsubscribe?t=abc.def">u</a>', 'Open: ${link}', 'stub', 'stubbed'),
           ('${siteIds[0]}', 'issue', '${sub.id}', 'old@example.com', 'Issue', '<a href="${link}">kept</a>', 'Open: ${link}', 'stub', 'stubbed')`,
        );

        const applied = await runMigrations(handle);
        const status = await getMigrationStatus(handle);
        expect(applied[0]).toBe('0004_newsletter_erasure');
        expect(applied.at(-1)).toBe(LATEST);
        expect(status.applied).toHaveLength(TOTAL);
        expect(status.pending).toEqual([]);

        const sites = await run<{ privacy_text: string; newsletter_postal_address: string; newsletter_erase_salt: string }>(
          handle,
          `select privacy_text, newsletter_postal_address, newsletter_erase_salt from site order by slug`,
        );
        expect(sites).toHaveLength(2);
        for (const s of sites) {
          expect(s.privacy_text).toBe(DEFAULT_PRIVACY_TEXT);
          expect(s.newsletter_postal_address).toBe('');
          expect(s.newsletter_erase_salt).toMatch(/^[0-9a-f]{64}$/);
        }
        expect(sites[0].newsletter_erase_salt).not.toBe(sites[1].newsletter_erase_salt);

        const msgs = await run<{ kind: string; html: string; text: string }>(handle, `select kind, html, "text" from newsletter_message order by kind`);
        const confirmation = msgs.find((m) => m.kind === 'confirmation')!;
        expect(confirmation.html).not.toContain(TOKEN);
        expect(confirmation.text).not.toContain(TOKEN);
        expect(confirmation.html).toContain('http://localhost:3410/newsletter/confirm?t=[redacted]');
        expect(confirmation.text).toBe('Open: http://localhost:3410/newsletter/confirm?t=[redacted]');
        expect(confirmation.html).toContain('/newsletter/unsubscribe?t=abc.def');
        expect(msgs.find((m) => m.kind === 'issue')!.html).toContain(TOKEN); // only confirmation rows are touched

        // the latest erase works on the migrated data
        expect((await erase(handle, sub.id)).erased).toBe(true);
      } finally {
        await handle.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe(`migration 0005_newsletter_erase_delete on a 0004 database with tombstones (${engine})`, () => {
    it('reproduces the 0004 collision, then repairs every tombstone: rows deleted, marker kept, audit row dated by the old erasure, issue counts kept; the live re-signup stays and erases cleanly', async () => {
      const dir = folderUpTo(5);
      const handle = await freshHandle(engine);
      try {
        await runMigrations(handle, dir);
        expect((await getMigrationStatus(handle, dir)).latestApplied).toBe('0004_newsletter_erasure');
        const site = await newSite(handle);
        const issueId = await newIssue(handle, site.id, 1);
        const first = await addReader(handle, site.id, EMAIL, issueId);
        const other = await addReader(handle, site.id, 'second.erased@example.com', issueId, { ...BYSTANDER, ip: '192.0.2.44', ua: 'Other/1.0', token: 'OTHERtoken' });
        const keep = await addReader(handle, site.id, 'stays@example.com', issueId, { ...BYSTANDER, ip: '198.51.100.8', ua: 'Stays/1.0', token: 'STAYStoken' });

        // 0004 behaviour: erase = tombstone in place
        for (const id of [first, other]) {
          const [r] = await run<{ erased: boolean }>(handle, `select newsletter_erase_subscriber('${id}'::uuid) as erased`);
          expect(r.erased).toBe(true);
        }
        const tomb = `erased+${erasureHash(site.salt, EMAIL)}@erased.invalid`;
        const [erasedEvent] = await run<{ created_at: Date | string }>(handle, `select created_at from newsletter_subscriber_event where subscriber_id = '${first}' and kind = 'erased'`);
        // the bug: the same address signs up again, confirms, and a second erase collides
        const [again] = await run<{ id: string }>(handle, `insert into newsletter_subscriber (site_id, email, status, signup_ip) values ('${site.id}', '${EMAIL}', 'confirmed', '${IP}') returning id`);
        expect(await refusal(handle, `select newsletter_erase_subscriber('${again.id}'::uuid)`)).toMatch(/newsletter_subscriber_site_email_unique|duplicate key/);
        expect(await count(handle, 'newsletter_subscriber', `email = '${tomb}'`)).toBe(1);

        const applied = await runMigrations(handle);
        expect(applied).toEqual(['0005_newsletter_erase_delete']);
        expect((await getMigrationStatus(handle)).pending).toEqual([]);

        // tombstones and everything hanging off them are gone
        expect(await count(handle, 'newsletter_subscriber', `email like 'erased+%@erased.invalid'`)).toBe(0);
        for (const id of [first, other]) {
          expect(await count(handle, 'newsletter_subscriber', `id = '${id}'`)).toBe(0);
          for (const t of ['newsletter_subscriber_event', 'newsletter_suppression', 'newsletter_message']) expect(await count(handle, t, `subscriber_id = '${id}'`), t).toBe(0);
        }
        expect(await count(handle, 'newsletter_suppression', `reason = 'erased'`)).toBe(0);
        // a marker per erased address, an audit row per repaired tombstone
        const markers = await run<{ email_hash: string }>(handle, `select email_hash from newsletter_erasure_marker where site_id = '${site.id}' order by email_hash`);
        expect(markers.map((m) => m.email_hash).sort()).toEqual([erasureHash(site.salt, EMAIL), erasureHash(site.salt, 'second.erased@example.com')].sort());
        const logs = await run<Record<string, unknown>>(handle, `select * from newsletter_erasure_log where site_id = '${site.id}' order by erased_at`);
        expect(logs).toHaveLength(2);
        for (const l of logs) expect(l).toMatchObject({ source: 'migration', erased_by: null, provider_outcome: 'skipped' });
        expect(new Date(logs[0].erased_at as string).getTime()).toBe(new Date(erasedEvent.created_at).getTime());
        // issue numbers intact: 3 deliveries, 2 of them deleted with the tombstones
        const [issue] = await run<{ erased_message_count: number }>(handle, `select erased_message_count from newsletter_issue where id = '${issueId}'`);
        expect(issue.erased_message_count).toBe(2);
        expect(await count(handle, 'newsletter_message', `issue_id = '${issueId}'`)).toBe(1);
        // nothing of the tombstones' addresses is left; the untouched reader and the live re-signup stay
        expect(await siteBlob(handle, site.id)).not.toContain('erased.invalid');
        expect(await count(handle, 'newsletter_subscriber', `id in ('${keep}', '${again.id}')`)).toBe(2);
        expect(await dump(handle, 'newsletter_subscriber', `id = '${keep}'`)).toContain('stays@example.com');

        // and the bug is fixed on the repaired database
        expect(await erase(handle, again.id)).toMatchObject({ erased: true, subscribers: 1 });
        expect(await siteBlob(handle, site.id)).not.toContain(EMAIL);
        expect(await count(handle, 'newsletter_erasure_marker', `site_id = '${site.id}'`)).toBe(2);
        // a migration that already ran never runs again
        expect(await runMigrations(handle)).toEqual([]);
      } finally {
        await handle.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}

migrationSuite('postgres');
migrationSuite('pglite');

afterAll(async () => {
  // leave the shared test database fully migrated for whichever file runs next
  await runMigrations(getTestDatabaseUrl());
});
