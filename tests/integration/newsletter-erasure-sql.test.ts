// Fix pass — erasure at the database level, on BOTH engines (PostgreSQL = the test database, PGlite =
// an in-memory instance): `newsletter_erase_subscriber(id)` (migration 0004_newsletter_erasure) redacts
// every personal datum of one subscriber across subscriber / events / suppressions / messages, leaves
// the proof (tombstone, `erased` suppression keyed by hash, one PII-free `erased` event), keeps the
// append-only guard shut for everything else, and migration 0004 redacts confirmation tokens already
// stored by earlier versions. Same SQL, same assertions, two engines.
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
const SOURCE_URL = '/p/erase-me-source-page';
const NAME = 'Erase Me Person';
const TOKEN = 'TOKENabcDEF123_-TOKENabcDEF123_-TOKENabcDEF12';
const PII = [EMAIL, IP, UA, SOURCE_URL, NAME, 'Erase.Me', TOKEN];

async function run<T = Record<string, unknown>>(handle: DbHandle, text: string): Promise<T[]> {
  return rowsOf<T>(await handle.db.execute(sql.raw(text)));
}

/** Runs a statement expecting the ledger guard to raise; returns the error text. */
async function refusal(handle: DbHandle, text: string): Promise<string> {
  try {
    await handle.db.execute(sql.raw(text));
  } catch (err) {
    const e = err as Error & { cause?: Error };
    return `${e.message} ${e.cause?.message ?? ''}`;
  }
  return '';
}

async function dump(handle: DbHandle, table: string, where: string): Promise<string> {
  const rows = await run<{ j: string }>(handle, `select to_jsonb(t)::text as j from ${table} t where ${where}`);
  return rows.map((r) => r.j).join('\n');
}

function sqlText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** A site, a subscriber with the full footprint of a confirmed + once-unsubscribed reader, and an unrelated bystander. */
let seq = 0;
async function seed(handle: DbHandle) {
  seq += 1;
  const [site] = await run<{ id: string; newsletter_erase_salt: string }>(
    handle,
    `insert into site (slug, brand_name, wordmark, publisher_name, tagline, contact_email, about_strap, about_stand, about_body_md)
     values ('erasure-${Math.random().toString(36).slice(2)}', 'blog0', 'blog0', 'smallTech', 't', 'hello@example.com', 's', 's', 'b')
     returning id, newsletter_erase_salt`,
  );
  const [a] = await run<{ id: string }>(
    handle,
    `insert into newsletter_subscriber (site_id, email, name, status, signup_source_url, signup_ip, signup_user_agent, consent_text, consent_version, consented_at,
        confirm_token_hash, confirm_token_expires_at, confirmed_at, confirmed_ip, confirmed_user_agent, provider_id)
     values ('${site.id}', '${EMAIL}', '${NAME}', 'confirmed', '${SOURCE_URL}', '${IP}', ${sqlText(UA)}, 'One issue a week.', 'v1', now(),
        'hash-of-${TOKEN}-${seq}', now() + interval '1 day', now(), '${IP}', ${sqlText(UA)}, 'provider-${EMAIL}') returning id`,
  );
  const [b] = await run<{ id: string }>(
    handle,
    `insert into newsletter_subscriber (site_id, email, name, status, signup_ip, signup_user_agent, confirmed_at)
     values ('${site.id}', 'bystander@example.com', 'By Stander', 'confirmed', '198.51.100.5', 'Bystander/1.0', now()) returning id`,
  );
  for (const [subscriber, email, ip, ua] of [
    [a.id, EMAIL, IP, UA],
    [b.id, 'bystander@example.com', '198.51.100.5', 'Bystander/1.0'],
  ]) {
    await run(
      handle,
      `insert into newsletter_subscriber_event (site_id, subscriber_id, email, kind, source, ip, user_agent, details) values
       ('${site.id}', '${subscriber}', '${email}', 'signup', 'footer', '${ip}', ${sqlText(ua)}, '{"sourceUrl":"${SOURCE_URL}","note":"${email}"}'::jsonb),
       ('${site.id}', '${subscriber}', '${email}', 'confirmed', 'email_link', '${ip}', ${sqlText(ua)}, '{"tokenHash":"hash-of-${TOKEN}-${seq}"}'::jsonb),
       ('${site.id}', '${subscriber}', '${email}', 'unsubscribed', 'one_click', '${ip}', ${sqlText(ua)}, '{"reason":"unsubscribed"}'::jsonb)`,
    );
    await run(
      handle,
      `insert into newsletter_suppression (site_id, subscriber_id, email, reason, source, details)
       values ('${site.id}', '${subscriber}', '${email}', 'unsubscribed', 'one_click', '{"note":"${email} asked"}'::jsonb)`,
    );
    await run(
      handle,
      `insert into newsletter_message (site_id, kind, subscriber_id, to_email, subject, html, "text", transport, status, error) values
       ('${site.id}', 'confirmation', '${subscriber}', '${email}', 'Confirm ${email}', '<a href="http://x/newsletter/confirm?t=[redacted]">${email}</a>', 'Hi ${email}', 'smtp', 'failed', '550 no such user ${email}'),
       ('${site.id}', 'issue', '${subscriber}', '${email}', 'Issue 1', '<p>Hi ${email}</p>', 'Hi ${email}', 'stub', 'stubbed', null)`,
    );
  }
  return { siteId: site.id, salt: site.newsletter_erase_salt, a: a.id, b: b.id };
}

async function erase(handle: DbHandle, id: string): Promise<boolean | null> {
  const [row] = await run<{ erased: boolean | null }>(handle, `select newsletter_erase_subscriber('${id}'::uuid) as erased`);
  return row.erased;
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

    it('redacts every personal datum of the subscriber, keeps the proof, and leaves the bystander untouched', async () => {
      const s = await seed(handle);
      const bystanderBefore = await Promise.all(
        ['newsletter_subscriber', 'newsletter_subscriber_event', 'newsletter_suppression', 'newsletter_message'].map((t) =>
          dump(handle, t, t === 'newsletter_subscriber' ? `id = '${s.b}'` : `subscriber_id = '${s.b}'`),
        ),
      );
      const [eventsBefore] = await run<{ n: string }>(handle, `select count(*)::text as n from newsletter_subscriber_event where subscriber_id = '${s.a}'`);

      expect(await erase(handle, s.a)).toBe(true);

      const hash = erasureHash(s.salt, EMAIL);
      const tombstone = `erased+${hash}@erased.invalid`;

      // 1. nothing of the subscriber still holds an address, IP, user agent, name, source URL or token
      const scans = {
        subscriber: await dump(handle, 'newsletter_subscriber', `id = '${s.a}'`),
        events: await dump(handle, 'newsletter_subscriber_event', `subscriber_id = '${s.a}'`),
        suppressions: await dump(handle, 'newsletter_suppression', `subscriber_id = '${s.a}'`),
        messages: await dump(handle, 'newsletter_message', `subscriber_id = '${s.a}'`),
      };
      for (const [label, text] of Object.entries(scans)) {
        for (const needle of PII) expect(text.toLowerCase(), `${label} still contains ${needle}`).not.toContain(needle.toLowerCase());
      }

      // 2. the subscriber row: tombstone, unsubscribed, nothing personal left
      const [sub] = await run<Record<string, unknown>>(handle, `select * from newsletter_subscriber where id = '${s.a}'`);
      expect(sub).toMatchObject({
        email: tombstone,
        status: 'unsubscribed',
        name: null,
        signup_ip: null,
        signup_user_agent: null,
        signup_source_url: null,
        confirmed_ip: null,
        confirmed_user_agent: null,
        confirm_token_hash: null,
        confirm_token_expires_at: null,
        provider_id: null,
      });
      expect(sub.unsubscribed_at).not.toBeNull();
      expect(sub.consent_version).toBe('v1'); // the consent record is not personal data

      // 3. events: same count + exactly one new `erased`, all PII-free and re-keyed to the tombstone
      const events = await run<Record<string, unknown>>(handle, `select * from newsletter_subscriber_event where subscriber_id = '${s.a}' order by created_at, id`);
      expect(events).toHaveLength(Number(eventsBefore.n) + 1);
      for (const e of events) expect(e).toMatchObject({ email: tombstone, ip: null, user_agent: null });
      expect(events.filter((e) => e.kind === 'erased')).toHaveLength(1);
      const erasedEvent = events.find((e) => e.kind === 'erased')!;
      expect(erasedEvent).toMatchObject({ source: 'admin', details: {} });
      expect(events.filter((e) => e.kind !== 'erased').map((e) => e.kind).sort()).toEqual(['confirmed', 'signup', 'unsubscribed']);
      expect(events.filter((e) => e.kind !== 'erased').every((e) => JSON.stringify(e.details) === '{}')).toBe(true);

      // 4. suppressions: history stays (reason/source/time), keyed by the hash, plus one `erased` row
      const sups = await run<Record<string, unknown>>(handle, `select * from newsletter_suppression where subscriber_id = '${s.a}' order by created_at, id`);
      expect(sups.map((x) => x.reason).sort()).toEqual(['erased', 'unsubscribed']);
      for (const row of sups) expect(row).toMatchObject({ email: tombstone, email_hash: hash, details: {} });
      expect(sups.find((x) => x.reason === 'erased')).toMatchObject({ source: 'admin' });
      expect(sups.find((x) => x.reason === 'unsubscribed')).toMatchObject({ source: 'one_click' });

      // 5. messages: rows stay, content gone
      const msgs = await run<Record<string, unknown>>(handle, `select * from newsletter_message where subscriber_id = '${s.a}' order by kind`);
      expect(msgs).toHaveLength(2);
      for (const m of msgs) expect(m).toMatchObject({ to_email: tombstone, subject: '[erased]', html: '[erased]', text: '[erased]' });
      expect(msgs.find((m) => m.kind === 'confirmation')!.error).toBe('[erased]');
      expect(msgs.find((m) => m.kind === 'issue')!.error).toBeNull();

      // 6. the bystander is byte-for-byte the same
      const bystanderAfter = await Promise.all(
        ['newsletter_subscriber', 'newsletter_subscriber_event', 'newsletter_suppression', 'newsletter_message'].map((t) =>
          dump(handle, t, t === 'newsletter_subscriber' ? `id = '${s.b}'` : `subscriber_id = '${s.b}'`),
        ),
      );
      expect(bystanderAfter).toEqual(bystanderBefore);
      expect(bystanderAfter.join('')).toContain('bystander@example.com');
    });

    it('is idempotent: a second call (or an unknown id) returns false and writes nothing', async () => {
      const s = await seed(handle);
      expect(await erase(handle, s.a)).toBe(true);
      const count = async () => (await run<{ n: string }>(handle, `select (select count(*) from newsletter_subscriber_event) + (select count(*) from newsletter_suppression) as n`))[0].n;
      const before = await count();

      expect(await erase(handle, s.a)).toBe(false);
      expect(await erase(handle, '00000000-0000-4000-8000-000000000000')).toBe(false);

      expect(await count()).toBe(before);
    });

    it('computes the tombstone with the per-site salt: the same address on another site hashes differently', async () => {
      const one = await seed(handle);
      const two = await seed(handle);
      expect(one.salt).toMatch(/^[0-9a-f]{64}$/);
      expect(two.salt).toMatch(/^[0-9a-f]{64}$/);
      expect(one.salt).not.toBe(two.salt);
      await erase(handle, one.a);
      await erase(handle, two.a);
      const [x] = await run<{ email: string }>(handle, `select email from newsletter_subscriber where id = '${one.a}'`);
      const [y] = await run<{ email: string }>(handle, `select email from newsletter_subscriber where id = '${two.a}'`);
      expect(x.email).toBe(`erased+${erasureHash(one.salt, EMAIL)}@erased.invalid`);
      expect(y.email).toBe(`erased+${erasureHash(two.salt, EMAIL)}@erased.invalid`);
      expect(x.email).not.toBe(y.email);
      // the SQL hash and the app hash are the same function, also for unusual casing / padding
      expect(erasureHash(one.salt, `  ${EMAIL.toUpperCase()} `)).toBe(erasureHash(one.salt, EMAIL));
    });

    it('the ledger stays append-only: every other UPDATE / DELETE still raises, before and after an erasure', async () => {
      const s = await seed(handle);
      await erase(handle, s.a);
      const [ev] = await run<{ id: string }>(handle, `select id from newsletter_subscriber_event where subscriber_id = '${s.b}' limit 1`);
      const [sup] = await run<{ id: string }>(handle, `select id from newsletter_suppression where subscriber_id = '${s.b}' limit 1`);
      const [erasedEv] = await run<{ id: string }>(handle, `select id from newsletter_subscriber_event where subscriber_id = '${s.a}' and kind = 'erased'`);

      const attempts = [
        `update newsletter_subscriber_event set email = 'x@example.com' where id = '${ev.id}'`,
        `update newsletter_subscriber_event set ip = null where id = '${ev.id}'`,
        `update newsletter_subscriber_event set kind = 'signup' where id = '${erasedEv.id}'`,
        `update newsletter_subscriber_event set details = '{"a":1}'::jsonb where id = '${erasedEv.id}'`,
        `delete from newsletter_subscriber_event where id = '${ev.id}'`,
        `delete from newsletter_subscriber_event where id = '${erasedEv.id}'`,
        `update newsletter_suppression set email = 'x@example.com' where id = '${sup.id}'`,
        `update newsletter_suppression set reason = 'admin' where id = '${sup.id}'`,
        `delete from newsletter_suppression where id = '${sup.id}'`,
      ];
      for (const text of attempts) expect(await refusal(handle, text), text).toMatch(/append-only/);

      // even with the erase flag raised by hand, only a redaction to the tombstone shape passes
      await run(handle, `select set_config('blog0.newsletter_erase', '1', false)`);
      try {
        for (const text of [
          `update newsletter_subscriber_event set email = 'x@example.com', ip = null, user_agent = null, details = '{}'::jsonb where id = '${ev.id}'`,
          `update newsletter_subscriber_event set kind = 'ip_pruned', email = 'erased+abc@erased.invalid', ip = null, user_agent = null, details = '{}'::jsonb where id = '${ev.id}'`,
          `update newsletter_suppression set reason = 'admin', email = 'erased+abc@erased.invalid', details = '{}'::jsonb where id = '${sup.id}'`,
          `delete from newsletter_subscriber_event where id = '${ev.id}'`,
          `delete from newsletter_suppression where id = '${sup.id}'`,
        ]) {
          expect(await refusal(handle, text), text).toMatch(/append-only/);
        }
      } finally {
        await run(handle, `select set_config('blog0.newsletter_erase', '0', false)`);
      }
    });

    it('the function is SECURITY DEFINER with a pinned search_path and the documented signature', async () => {
      const [fn] = await run<{ args: string; secdef: boolean; config: string[] | string | null; returns: string }>(
        handle,
        `select pg_get_function_identity_arguments(p.oid) as args, p.prosecdef as secdef, p.proconfig as config, pg_get_function_result(p.oid) as returns
         from pg_proc p where p.proname = 'newsletter_erase_subscriber'`,
      );
      expect(fn.args).toBe('p_subscriber_id uuid');
      expect(fn.returns).toBe('boolean');
      expect(fn.secdef).toBe(true);
      expect(JSON.stringify(fn.config)).toContain('search_path=');
    });

    it('accepts the new `erased` kinds and still refuses anything else', async () => {
      const s = await seed(handle);
      await run(
        handle,
        `insert into newsletter_subscriber_event (site_id, subscriber_id, email, kind, source) values ('${s.siteId}', '${s.a}', 'x@example.com', 'erased', 'admin')`,
      );
      expect(await refusal(handle, `insert into newsletter_subscriber_event (site_id, subscriber_id, email, kind, source) values ('${s.siteId}', '${s.a}', 'x@example.com', 'wiped', 'admin')`)).toMatch(/check/i);
      expect(await refusal(handle, `insert into newsletter_suppression (site_id, subscriber_id, email, reason, source) values ('${s.siteId}', '${s.a}', 'x@example.com', 'wiped', 'admin')`)).toMatch(/check/i);
    });
  });
}

engineSuite('postgres');
engineSuite('pglite');

// --- migration 0004 on a database that already holds data ---------------------------------------

function folderWithoutLatest(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'blog0-mig4-'));
  cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
  rmSync(path.join(dir, '0004_newsletter_erasure.sql'));
  rmSync(path.join(dir, 'meta', '0004_snapshot.json'));
  const journal = readJournal(MIGRATIONS_FOLDER);
  writeFileSync(path.join(dir, 'meta', '_journal.json'), JSON.stringify({ version: '7', dialect: 'postgresql', entries: journal.filter((e) => e.idx < 4) }));
  return dir;
}

function migrationSuite(engine: Engine) {
  describe(`migration 0004_newsletter_erasure on a 0003 database (${engine})`, () => {
    it('adds the site columns (draft privacy text, empty address, a distinct random salt per existing site), redacts stored confirmation tokens only, and ends at 5 applied', async () => {
      const dir = folderWithoutLatest();
      let handle: DbHandle;
      if (engine === 'pglite') {
        handle = await openPglite('memory');
      } else {
        const url = getTestDatabaseUrl();
        await closeDb();
        const admin = postgres(url, { max: 1, onnotice: () => {} });
        try {
          await admin.unsafe('drop schema if exists drizzle cascade; drop schema if exists public cascade; create schema public;');
        } finally {
          await admin.end({ timeout: 5 });
        }
        handle = await createDbHandle({ engine: 'postgres', url }, { max: 1 });
      }
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
        expect(applied).toEqual(['0004_newsletter_erasure']);
        expect(status.applied).toHaveLength(5);
        expect(status.latestApplied).toBe('0004_newsletter_erasure');
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

        // the new function exists and works on the migrated data
        const [erased] = await run<{ erased: boolean }>(handle, `select newsletter_erase_subscriber('${sub.id}'::uuid) as erased`);
        expect(erased.erased).toBe(true);
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
