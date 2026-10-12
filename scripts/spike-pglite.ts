// pnpm spike:pglite — S2.0: can the v0.1 schema + the service-layer query shapes run unchanged on
// embedded PGlite via drizzle-orm/pglite? (spec/architecture.md §11.3 risk table, §11.4 spike.)
// Opens a fresh PGlite dir under var/, applies the SAME migration folder with drizzle's pglite
// migrator, then exercises one probe per risk point. Prints PASS/FAIL per probe + timing and exits
// non-zero on any FAIL. The verdict is written by hand to spec/spikes/pglite.md (the task owner
// reads this output); the script never touches spec/.
import './lib/allow-server-only';

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

import type { PGlite } from '@electric-sql/pglite';
import { and, eq, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { latestGeneration, lockArticle } from '../src/server/articles/repo';
import type { Db as PostgresDb, Tx as PostgresTx } from '../src/server/db/client';
import * as schema from '../src/server/db/schema';
import { GENERATION_STALE_MS, isGenerationActive } from '../src/server/formats/types';
import { seedAdmin } from '../src/server/seed/admin';
import { seedSite } from '../src/server/seed/site';

const { aiGeneration, appUser, article, articleFormat, articleRevision, session, site } = schema;

// §11.2 compile-time check: the engine-neutral `Db` type S2.8 introduces must accept BOTH drivers.
// If either assignment stops compiling, `pnpm typecheck` fails — that is the probe.
type NeutralDb = PgDatabase<PgQueryResultHKT, typeof schema>;
type NeutralTx = Parameters<Parameters<NeutralDb['transaction']>[0]>[0];
export const neutralFromPglite = (db: PgliteDatabase<typeof schema>): NeutralDb => db;
export const neutralFromPostgres = (db: PostgresJsDatabase<typeof schema>): NeutralDb => db;
// Today's service code is typed against PostgresJsDatabase; until S2.8 retypes `Db`/`Tx` the spike
// passes the PGlite handle through these casts (runtime is identical — same PgDatabase methods).
const asServiceDb = (db: NeutralDb): PostgresDb => db as unknown as PostgresDb;
const asServiceTx = (tx: NeutralTx): PostgresTx => tx as unknown as PostgresTx;

// Same folder / ledger location as src/server/db/migrate.ts (kept in sync by S2.8).
const MIGRATIONS_FOLDER = path.join(process.cwd(), 'src', 'server', 'db', 'migrations');
const MIGRATIONS_SCHEMA = 'drizzle';
const MIGRATIONS_TABLE = '__drizzle_migrations';
const SPIKE_DIR = path.join(process.cwd(), 'var', 'pglite-spike');

type Db = PgliteDatabase<typeof schema>;

interface ProbeResult {
  name: string;
  ok: boolean;
  ms: number;
  note: string;
}

const results: ProbeResult[] = [];

async function probe(name: string, fn: () => Promise<string | void>): Promise<void> {
  const started = performance.now();
  try {
    const note = (await fn()) ?? '';
    const ms = Math.round(performance.now() - started);
    results.push({ name, ok: true, ms, note });
    console.log(`PASS  ${name}  (${ms} ms)${note ? `  — ${note}` : ''}`);
  } catch (error) {
    const ms = Math.round(performance.now() - started);
    const message = error instanceof Error ? error.message : String(error);
    results.push({ name, ok: false, ms, note: message });
    console.log(`FAIL  ${name}  (${ms} ms)  — ${message}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Same lookup as articles/service.ts `pgCode`: drizzle 0.45 wraps driver errors in DrizzleQueryError
 * ("Failed query: …") with the driver's error (carrying the SQLSTATE `code`) on `.cause`. */
function pgCode(error: unknown): string | undefined {
  const e = error as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.code ?? e?.cause?.code;
  return typeof code === 'string' ? code : undefined;
}

function causeMessage(error: unknown): string {
  const cause = (error as { cause?: unknown } | null)?.cause;
  return cause instanceof Error ? cause.message : '';
}

/** Expects `fn` to throw an error whose SQLSTATE (via pgCode) is `code`. Returns the driver message. */
async function expectPgError(fn: () => Promise<unknown>, code: string): Promise<string> {
  try {
    await fn();
  } catch (error) {
    const got = pgCode(error);
    const message = causeMessage(error) || (error instanceof Error ? error.message : String(error));
    assert(got === code, `expected SQLSTATE ${code}, got ${String(got)}: ${message.split('\n')[0]}`);
    return `${code} "${message.split('\n')[0]}"`;
  }
  throw new Error(`expected SQLSTATE ${code}, but the statement succeeded`);
}

async function expectError(fn: () => Promise<unknown>, pattern: RegExp): Promise<string> {
  try {
    await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(pattern.test(message), `expected error matching ${pattern}, got: ${message}`);
    return message;
  }
  throw new Error(`expected an error matching ${pattern}, but the statement succeeded`);
}

function dirSizeBytes(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSizeBytes(full) : statSync(full).size;
  }
  return total;
}

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const TIMED_OUT = Symbol('timed-out');
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  return Promise.race([p, new Promise<typeof TIMED_OUT>((r) => setTimeout(() => r(TIMED_OUT), ms))]);
}

async function main(): Promise<void> {
  const wall = performance.now();
  rmSync(SPIKE_DIR, { recursive: true, force: true });
  mkdirSync(path.dirname(SPIKE_DIR), { recursive: true });

  let client: PGlite | undefined;
  let db!: Db;
  let pgVersion = '?';
  let pgliteVersion = '?';
  let PGliteCtor!: typeof PGlite;
  const timings: Record<string, number> = {};

  await probe('cold start: import @electric-sql/pglite (module + WASM load)', async () => {
    const t = performance.now();
    PGliteCtor = (await import('@electric-sql/pglite')).PGlite;
    timings.import = Math.round(performance.now() - t);
    // package.json is not in the package's "exports" map → read it from disk.
    const pkgPath = path.join(process.cwd(), 'node_modules', '@electric-sql', 'pglite', 'package.json');
    pgliteVersion = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version;
    return `${timings.import} ms, @electric-sql/pglite ${pgliteVersion}`;
  });

  await probe('cold start: new PGlite(<fresh dir>) → waitReady (initdb on first open)', async () => {
    const t = performance.now();
    client = new PGliteCtor(SPIKE_DIR);
    await client.waitReady;
    timings.initdb = Math.round(performance.now() - t);
    db = drizzle(client, { schema });
    const [row] = (await db.execute<{ v: string }>(sql`select current_setting('server_version') as v`)).rows;
    pgVersion = row!.v;
    return `${timings.initdb} ms, server_version ${pgVersion}, empty cluster ${mb(dirSizeBytes(SPIKE_DIR))} on disk`;
  });
  if (!client) throw new Error('PGlite did not open');

  // --- #1/#2/#7-shape: the SAME migration folder through drizzle's pglite migrator ----------------
  let migrateMs = 0;
  await probe('risk #2  apply 0000_init.sql verbatim via drizzle-orm/pglite/migrator', async () => {
    const t = performance.now();
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER, migrationsSchema: MIGRATIONS_SCHEMA, migrationsTable: MIGRATIONS_TABLE });
    migrateMs = Math.round(performance.now() - t);
    const tables = (
      await db.execute<{ n: string }>(sql`select table_name as n from information_schema.tables where table_schema = 'public' order by 1`)
    ).rows.map((r) => r.n);
    const expected = [...schema.ALL_TABLE_NAMES].sort();
    assert(JSON.stringify(tables) === JSON.stringify(expected), `tables ${tables.join(',')} != ${expected.join(',')}`);
    return `${tables.length} tables in ${migrateMs} ms`;
  });

  await probe('risk #2  every index from 0000_init.sql exists (incl. DESC NULLS LAST)', async () => {
    const expectedIdx = [
      'ai_generation_site_started_idx',
      'ai_generation_article_started_idx',
      'app_user_site_email_unique',
      'article_site_slug_unique',
      'article_site_status_published_idx',
      'article_site_featured_idx',
      'article_format_article_kind_unique',
      'article_revision_article_number_unique',
      'newsletter_subscriber_site_email_unique',
      'session_user_idx',
    ];
    const rows = (await db.execute<{ indexname: string; indexdef: string }>(sql`select indexname, indexdef from pg_indexes where schemaname = 'public'`)).rows;
    const byName = new Map(rows.map((r) => [r.indexname, r.indexdef]));
    const missing = expectedIdx.filter((n) => !byName.has(n));
    assert(missing.length === 0, `missing indexes: ${missing.join(', ')}`);
    assert(/DESC NULLS LAST/.test(byName.get('ai_generation_site_started_idx') ?? ''), 'DESC NULLS LAST not preserved');
    return `${expectedIdx.length}/${expectedIdx.length} indexes`;
  });

  await probe('risk #2  CHECK constraints (4) + unique constraints enforced', async () => {
    // Scoped to `public`: information_schema's own domains (cardinal_number_domain_check,
    // yes_or_no_check) also live in pg_constraint — on real Postgres too.
    const checks = (
      await db.execute<{ conname: string }>(
        sql`select c.conname from pg_constraint c join pg_namespace n on n.oid = c.connamespace where c.contype = 'c' and n.nspname = 'public' order by 1`,
      )
    ).rows.map((r) => r.conname);
    const expectedChecks = ['ai_generation_status_check', 'article_status_check', 'media_asset_kind_check', 'newsletter_subscriber_status_check'];
    assert(JSON.stringify(checks) === JSON.stringify(expectedChecks), `check constraints: ${checks.join(',')}`);
    // CHECKs are evaluated before FK triggers, so a random site_id still yields 23514 (not 23503).
    const message = await expectPgError(
      () => db.execute(sql`insert into newsletter_subscriber (site_id, email, status) values (gen_random_uuid(), 'x@y.z', 'bogus')`),
      '23514',
    );
    return `${checks.length} CHECKs; rejects bad status: ${message}`;
  });

  await probe('risk #7  getMigrationStatus queries via db.execute(sql`…`) + sql.identifier()', async () => {
    const [meta] = (
      await db.execute<{ database: string; server_version: string }>(sql`select current_database() as database, current_setting('server_version') as server_version`)
    ).rows;
    const [ledger] = (await db.execute<{ exists: boolean }>(sql`select to_regclass(${`${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}`}) is not null as exists`)).rows;
    assert(ledger?.exists === true, `ledger exists=${String(ledger?.exists)} (expected boolean true)`);
    const rows = (
      await db.execute<{ created_at: string }>(sql`select created_at::text as created_at from ${sql.identifier(MIGRATIONS_SCHEMA)}.${sql.identifier(MIGRATIONS_TABLE)}`)
    ).rows;
    assert(rows.length === 1 && typeof rows[0]!.created_at === 'string', `ledger rows: ${JSON.stringify(rows)}`);
    return `database=${meta!.database}, server_version=${meta!.server_version.split(' ')[0]}, ledger rows=${rows.length}`;
  });

  await probe('risk #8  health ping: select 1 as ok (db.execute) + version() string', async () => {
    const t = performance.now();
    const res = await db.execute<{ ok: number }>(sql`select 1 as ok`);
    const pingMs = (performance.now() - t).toFixed(2);
    assert(res.rows[0]?.ok === 1, `rows=${JSON.stringify(res.rows)}`);
    // db.execute shape differs per driver: pglite → { rows, fields, affectedRows }; postgres-js → RowList (an array).
    assert(!Array.isArray(res) && Array.isArray(res.rows), 'pglite execute() result is not { rows }');
    const [v] = (await db.execute<{ v: string }>(sql`select version() as v`)).rows;
    return `${pingMs} ms; version()="${v!.v}"`;
  });

  // --- #1 / #6 / #13: inserts with defaults ----------------------------------------------------
  let siteId = '';
  let userId = '';
  await probe('risk #1  site insert with no explicit id (gen_random_uuid()/now() defaults)', async () => {
    const [row] = await db
      .insert(site)
      .values({
        slug: 'spike',
        brandName: 'blog0',
        wordmark: 'log0',
        publisherName: 'smallTech',
        tagline: 't',
        contactEmail: 'spike@blog0.local',
        aboutStrap: '',
        aboutStand: '',
        aboutBodyMd: '',
      })
      .returning();
    assert(row && /^[0-9a-f-]{36}$/.test(row.id), 'id not a uuid');
    assert(row.createdAt instanceof Date && row.updatedAt instanceof Date, 'timestamps not Date');
    assert(row.timezone === 'Asia/Kolkata', 'text default not applied');
    siteId = row.id;
    return `id=${row.id.slice(0, 8)}… createdAt=${row.createdAt.toISOString()}`;
  });

  await probe('risk #6  onConflictDoNothing({ target }) (seedSite / users.repo pattern)', async () => {
    const again = await db
      .insert(site)
      .values({ slug: 'spike', brandName: 'dup', wordmark: 'd', publisherName: 'd', tagline: 'd', contactEmail: 'd', aboutStrap: '', aboutStand: '', aboutBodyMd: '' })
      .onConflictDoNothing({ target: site.slug })
      .returning();
    assert(again.length === 0, `expected no rows, got ${again.length}`);
    const count = (await db.select({ n: sql<number>`count(*)::int` }).from(site))[0]!.n;
    assert(count === 1, `site count ${count}`);
  });

  await probe('risk #1  app_user insert + unique index (site_id,email) via uniqueIndex', async () => {
    const [u] = await db
      .insert(appUser)
      .values({ siteId, email: 'designer@blog0.local', displayName: 'Designer', passwordHash: '$argon2id$spike' })
      .returning();
    assert(u, 'no user');
    userId = u.id;
    const message = await expectPgError(
      () => db.insert(appUser).values({ siteId, email: 'designer@blog0.local', displayName: 'Dup', passwordHash: 'x' }),
      '23505',
    );
    return `duplicate rejected; service.ts pgCode() sees ${message}`;
  });

  await probe('risk #6  real seed code on PGlite: seedSite ×2 + seedAdmin ×2 (argon2 hash, onConflictDoNothing)', async () => {
    const serviceDb = asServiceDb(db);
    const first = await seedSite(serviceDb, 'spike-seed');
    const second = await seedSite(serviceDb, 'spike-seed');
    assert(first.status === 'created' && second.status === 'ok' && first.site.id === second.site.id, `seedSite: ${first.status}/${second.status}`);
    const creds = { email: 'admin@blog0.local', password: 'spike-password-123456', displayName: 'Spike Admin' };
    const a1 = await seedAdmin(serviceDb, first.site.id, creds);
    const a2 = await seedAdmin(serviceDb, first.site.id, creds);
    assert(a1.status === 'created' && a2.status === 'ok' && a1.userId === a2.userId, `seedAdmin: ${a1.status}/${a2.status}`);
    return `seedSite created→ok, seedAdmin created→ok`;
  });

  // --- session (auth/session.ts shape) -----------------------------------------------------------
  await probe('session insert/select/update with timestamptz round-trip (auth/session.ts)', async () => {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
    const [inserted] = await db
      .insert(session)
      .values({ siteId, userId, tokenHash: 'hash-1', lastSeenAt: now, expiresAt, userAgent: 'spike', ip: '127.0.0.1' })
      .returning({ id: session.id });
    assert(inserted, 'no session');
    const [row] = await db
      .select({ id: session.id, expiresAt: session.expiresAt, lastSeenAt: session.lastSeenAt, user: { id: appUser.id, email: appUser.email } })
      .from(session)
      .innerJoin(appUser, eq(appUser.id, session.userId))
      .where(and(eq(session.tokenHash, 'hash-1'), eq(session.siteId, siteId)))
      .limit(1);
    assert(row && row.expiresAt instanceof Date && row.lastSeenAt instanceof Date, 'timestamps not Date');
    assert(row.expiresAt.getTime() === expiresAt.getTime(), `expiresAt drift: ${row.expiresAt.toISOString()} vs ${expiresAt.toISOString()}`);
    assert(row.lastSeenAt.getTime() === now.getTime(), `lastSeenAt drift (ms precision): ${row.lastSeenAt.toISOString()} vs ${now.toISOString()}`);
    await db.update(session).set({ lastSeenAt: new Date(), expiresAt }).where(eq(session.id, row.id));
    // onDelete cascade: deleting the user removes the session.
    const [tmp] = await db.insert(appUser).values({ siteId, email: 'tmp@blog0.local', displayName: 'T', passwordHash: 'x' }).returning();
    await db.insert(session).values({ siteId, userId: tmp!.id, tokenHash: 'hash-tmp', expiresAt });
    await db.delete(appUser).where(eq(appUser.id, tmp!.id));
    const left = await db.select({ id: session.id }).from(session).where(eq(session.tokenHash, 'hash-tmp'));
    assert(left.length === 0, 'cascade delete did not remove session');
    return 'ms-precision preserved; FK cascade works';
  });

  // --- article + revision + self-referencing FKs ------------------------------------------------
  let articleId = '';
  let revisionId = '';
  await probe('article insert + revision + current_revision_id (self-ref FK, set null) + transaction', async () => {
    await db.transaction(async (tx) => {
      const [a] = await tx.insert(article).values({ siteId, slug: 'humans-are-software', bylineName: 'Sai', createdBy: userId }).returning();
      assert(a, 'no article');
      articleId = a.id;
      const [r] = await tx
        .insert(articleRevision)
        .values({
          siteId,
          articleId,
          number: 1,
          title: 'Humans are software',
          dek: 'dek',
          bodyMd: 'Para one. Para two.',
          bodyFingerprint: 'b1',
          paragraphsFingerprint: 'p1',
          sentencesFingerprint: 's1',
          wordCount: 4,
          eligibleSentenceCount: 2,
          createdBy: userId,
        })
        .returning();
      assert(r, 'no revision');
      revisionId = r.id;
      await tx.update(article).set({ currentRevisionId: revisionId, status: 'published', firstPublishedAt: new Date() }).where(eq(article.id, articleId));
    });
    const row = await db.query.article.findFirst({ where: eq(article.id, articleId) });
    assert(row?.currentRevisionId === revisionId, 'currentRevisionId not set');
    assert(row.status === 'published', 'status not updated');
    await expectPgError(() => db.update(article).set({ status: 'bogus' as 'draft' }).where(eq(article.id, articleId)), '23514');
    // FK set null: deleting the revision nulls article.current_revision_id — exercised on a throwaway pair.
    const [a2] = await db.insert(article).values({ siteId, slug: 'fk-probe', bylineName: 'x', createdBy: userId }).returning();
    const [r2] = await db
      .insert(articleRevision)
      .values({ siteId, articleId: a2!.id, number: 1, title: 't', dek: '', bodyMd: 'x', bodyFingerprint: 'b', paragraphsFingerprint: 'p', sentencesFingerprint: 's', wordCount: 1, eligibleSentenceCount: 1, createdBy: userId })
      .returning();
    await db.update(article).set({ currentRevisionId: r2!.id }).where(eq(article.id, a2!.id));
    await db.delete(articleRevision).where(eq(articleRevision.id, r2!.id));
    const after = await db.query.article.findFirst({ where: eq(article.id, a2!.id) });
    assert(after && after.currentRevisionId === null, `set null FK: currentRevisionId=${String(after?.currentRevisionId)}`);
    await db.delete(article).where(eq(article.id, a2!.id));
    return 'tx commit, CHECK 23514 on update, FK set null, relational query API (db.query.*)';
  });

  await probe('risk #4  db.transaction rollback (throw inside) leaves no row', async () => {
    await expectError(
      () =>
        db.transaction(async (tx) => {
          await tx.insert(article).values({ siteId, slug: 'rolled-back', bylineName: 'x', createdBy: userId });
          throw new Error('abort-on-purpose');
        }),
      /abort-on-purpose/,
    );
    const rows = await db.select({ id: article.id }).from(article).where(eq(article.slug, 'rolled-back'));
    assert(rows.length === 0, 'rollback did not discard the insert');
  });

  // --- #3 / #4: the Generate-lock transaction ---------------------------------------------------
  let generationId = '';
  await probe('risk #3/#4  Generate lock tx: SELECT … FOR UPDATE → insert ai_generation running → commit', async () => {
    const now = new Date();
    const inserted = await db.transaction(async (tx) => {
      // The real repo.ts lockArticle (… limit 1 FOR UPDATE), unchanged.
      const locked = await lockArticle(asServiceTx(tx), siteId, articleId);
      assert(locked && locked.id === articleId, 'FOR UPDATE did not return the row');
      const [gen] = await tx
        .insert(aiGeneration)
        .values({
          siteId,
          articleId,
          revisionId,
          formatKind: 'tldr',
          task: 'tldr.pick',
          status: 'running',
          requestedBy: userId,
          startedAt: now,
          model: 'spike/model',
          promptVersion: 'v1',
          inputFingerprint: 's1',
          sentenceCount: 2,
          boundMin: 1,
          boundMax: 2,
        })
        .returning();
      assert(gen, 'no generation');
      return gen;
    });
    generationId = inserted.id;
    assert(inserted.status === 'running' && inserted.attempts === 0, 'defaults wrong');
    assert(Array.isArray(inserted.providerGenerationIds) && inserted.providerGenerationIds.length === 0, `provider_generation_ids default: ${JSON.stringify(inserted.providerGenerationIds)}`);
    return `generation ${generationId.slice(0, 8)}… status=running, provider_generation_ids='{}' → []`;
  });

  await probe('risk #3  FOR UPDATE semantics: concurrent db.transaction() calls run strictly one after another', async () => {
    // PGlite is ONE backend; client.transaction() holds an in-process transaction mutex for the whole
    // callback. A second db.transaction() issued while the first is open does not even START its
    // callback until the first commits — so FOR UPDATE never has a second session to block; the
    // exclusion comes from the mutex (stronger than a row lock: it is whole-database).
    const order: string[] = [];
    const t1 = db.transaction(async (tx) => {
      order.push('t1-start');
      await lockArticle(asServiceTx(tx), siteId, articleId);
      await tx.update(article).set({ topic: 'from-t1' }).where(eq(article.id, articleId));
      await new Promise((r) => setTimeout(r, 50));
      order.push('t1-end');
    });
    const t2 = db.transaction(async (tx) => {
      order.push('t2-start');
      const row = await lockArticle(asServiceTx(tx), siteId, articleId);
      order.push(`t2-saw:${row!.topic}`);
      order.push('t2-end');
    });
    await Promise.all([t1, t2]);
    assert(order.join(',') === 't1-start,t1-end,t2-start,t2-saw:from-t1,t2-end', `unexpected interleaving: ${order.join(',')}`);
    return `serialised: ${order.join(' → ')}`;
  });

  await probe('risk #3  a plain (non-tx) db query issued while a tx is open waits for the commit', async () => {
    const order: string[] = [];
    const t1 = db.transaction(async (tx) => {
      await tx.update(article).set({ topic: 'tx-uncommitted' }).where(eq(article.id, articleId));
      order.push('tx-wrote');
      await new Promise((r) => setTimeout(r, 50));
      await tx.update(article).set({ topic: 'from-t1' }).where(eq(article.id, articleId));
      order.push('tx-commit');
    });
    await new Promise((r) => setTimeout(r, 5));
    const outside = db
      .select({ topic: article.topic })
      .from(article)
      .where(eq(article.id, articleId))
      .then(([r]) => order.push(`outside-saw:${r!.topic}`));
    await Promise.all([t1, outside]);
    assert(order.join(',') === 'tx-wrote,tx-commit,outside-saw:from-t1', `order: ${order.join(',')}`);
    return `${order.join(' → ')} (no dirty read, no interleave)`;
  });

  await probe('risk #3  QUIRK: using the outer db (getDb()) INSIDE a tx callback deadlocks on PGlite', async () => {
    // On postgres-js this is merely a second pooled connection; on PGlite the outer query queues
    // behind the open transaction's mutex, and the transaction is awaiting it → deadlock.
    // Detected with a 1.5 s timeout; the callback then returns so the tx commits and the queued
    // query drains.
    let pending: Promise<unknown> | undefined;
    const outcome = await db.transaction(async (tx) => {
      await tx.select({ id: article.id }).from(article).where(eq(article.id, articleId));
      pending = db.select({ id: article.id }).from(article).where(eq(article.id, articleId));
      return withTimeout(pending, 1500);
    });
    await pending;
    assert(outcome === TIMED_OUT, 'outer-db query inside a tx completed — PGlite no longer deadlocks here (update the spike notes)');
    return 'confirmed: outer query inside tx never resolves → every repo call inside a tx MUST receive `tx`';
  });

  await probe('running-row guard (tldr.ts step 2): lockArticle → latestGeneration(tx) [DISTINCT ON] → isGenerationActive', async () => {
    // A second Generate click: the same tx shape as tldr.ts, which must refuse while the row is young.
    const secondClick = (now: Date) =>
      db.transaction(async (tx) => {
        const locked = await lockArticle(asServiceTx(tx), siteId, articleId);
        assert(locked, 'lock lost the row');
        const latest = await latestGeneration(siteId, articleId, 'tldr', asServiceTx(tx));
        assert(latest && latest.id === generationId && latest.startedAt instanceof Date, `latest=${JSON.stringify(latest?.id)}`);
        if (isGenerationActive(latest, now)) throw new Error('GENERATION_IN_PROGRESS');
        return 'would-insert';
      });
    await expectError(() => secondClick(new Date()), /GENERATION_IN_PROGRESS/);
    const later = await secondClick(new Date(Date.now() + GENERATION_STALE_MS + 1));
    assert(later === 'would-insert', 'stale running row should release the guard');
    return 'young running row → GENERATION_IN_PROGRESS (tx rolled back); stale → allowed';
  });

  // --- #5 / #13: success tx with numeric + text[] + jsonb and upsertDraft ×2 -------------------
  await probe('risk #13  update to succeeded: cost_usd numeric(12,6) → number, provider_generation_ids → string[], jsonb output', async () => {
    const [succeeded] = await db
      .update(aiGeneration)
      .set({
        status: 'succeeded',
        finishedAt: new Date(),
        promptTokens: 1200,
        completionTokens: 80,
        totalTokens: 1280,
        costUsd: 0.001234,
        latencyMs: 1500,
        attempts: 1,
        providerGenerationIds: ['gen-abc', 'gen-def'],
        output: { picks: [{ index: 0, sid: 'p1s1', reason: 'r' }] },
      })
      .where(and(eq(aiGeneration.id, generationId), eq(aiGeneration.siteId, siteId)))
      .returning();
    assert(succeeded, 'no row');
    assert(typeof succeeded.costUsd === 'number' && succeeded.costUsd === 0.001234, `costUsd=${JSON.stringify(succeeded.costUsd)} (${typeof succeeded.costUsd})`);
    assert(JSON.stringify(succeeded.providerGenerationIds) === '["gen-abc","gen-def"]', `ids=${JSON.stringify(succeeded.providerGenerationIds)}`);
    const out = succeeded.output as { picks: { sid: string }[] };
    assert(out.picks[0]!.sid === 'p1s1', 'jsonb output not round-tripped');
    // And via a plain select (not RETURNING) — the raw read path the ledger uses.
    const [re] = await db.select({ cost: aiGeneration.costUsd, ids: aiGeneration.providerGenerationIds }).from(aiGeneration).where(eq(aiGeneration.id, generationId));
    assert(typeof re!.cost === 'number' && Array.isArray(re!.ids) && re!.ids[1] === 'gen-def', `select: ${JSON.stringify(re)}`);
    const [sum] = await db.select({ total: sql<string>`coalesce(sum(${aiGeneration.costUsd}), 0)::text` }).from(aiGeneration).where(eq(aiGeneration.siteId, siteId));
    return `costUsd=${succeeded.costUsd} ids=${succeeded.providerGenerationIds.join('|')} sum=${sum!.total}`;
  });

  await probe('risk #5  upsertDraft ×2: onConflictDoUpdate({ target, set, setWhere }) inside db.transaction', async () => {
    const payload1 = { slides: [{ sid: 'p1s1', text: 'Para one.', source: 'jev', reason: null }], generationId };
    const payload2 = { slides: [{ sid: 'p1s2', text: 'Para two.', source: 'writer', reason: 'better' }], generationId };
    const upsert = (payload: object, when: Date) =>
      db.transaction(async (tx) => {
        const values = { draftPayload: payload, draftRevisionId: revisionId, draftFingerprint: 's1', draftUpdatedBy: userId, draftUpdatedAt: when };
        await tx
          .insert(articleFormat)
          .values({ siteId, articleId, kind: 'tldr', ...values })
          .onConflictDoUpdate({ target: [articleFormat.articleId, articleFormat.kind], set: values, setWhere: eq(articleFormat.siteId, siteId) });
      });
    await upsert(payload1, new Date(1_000_000));
    await upsert(payload2, new Date(2_000_000));
    const rows = await db.select().from(articleFormat).where(eq(articleFormat.articleId, articleId));
    assert(rows.length === 1, `expected 1 format row, got ${rows.length}`);
    const draft = rows[0]!.draftPayload as typeof payload2;
    assert(draft.slides[0]!.sid === 'p1s2', 'second upsert did not replace the draft');
    assert(rows[0]!.draftUpdatedAt?.getTime() === 2_000_000, 'draftUpdatedAt not updated');
    // setWhere mismatch (other site) → conflict row NOT updated, no error.
    await db
      .insert(articleFormat)
      .values({ siteId, articleId, kind: 'tldr', draftFingerprint: 'should-not-apply' })
      .onConflictDoUpdate({ target: [articleFormat.articleId, articleFormat.kind], set: { draftFingerprint: 'should-not-apply' }, setWhere: eq(articleFormat.siteId, '00000000-0000-0000-0000-000000000000') });
    const [after] = await db.select({ fp: articleFormat.draftFingerprint }).from(articleFormat).where(eq(articleFormat.articleId, articleId));
    assert(after!.fp === 's1', `setWhere ignored: fp=${after!.fp}`);
    return 'insert → update → setWhere-guarded no-op, 1 row';
  });

  await probe('reader-shape query: join article ⋈ revision ⋈ format, order by first_published_at desc', async () => {
    const rows = await db
      .select({ slug: article.slug, title: articleRevision.title, deck: articleFormat.draftPayload, publishedAt: article.firstPublishedAt })
      .from(article)
      .innerJoin(articleRevision, eq(articleRevision.id, article.currentRevisionId))
      .leftJoin(articleFormat, and(eq(articleFormat.articleId, article.id), eq(articleFormat.kind, 'tldr')))
      .where(and(eq(article.siteId, siteId), eq(article.status, 'published')))
      .orderBy(sql`${article.firstPublishedAt} desc nulls last`);
    assert(rows.length === 1 && rows[0]!.title === 'Humans are software' && rows[0]!.deck !== null, JSON.stringify(rows));
  });

  await probe('persistence + warm cold-start: close, reopen the dir, migrator is a no-op, data survived', async () => {
    await client!.close();
    client = undefined;
    timings.diskBytes = dirSizeBytes(SPIKE_DIR);
    const t = performance.now();
    const reopened = new PGliteCtor(SPIKE_DIR);
    await reopened.waitReady;
    timings.reopen = Math.round(performance.now() - t);
    try {
      const db2 = drizzle(reopened, { schema });
      const tm = performance.now();
      await migrate(db2, { migrationsFolder: MIGRATIONS_FOLDER, migrationsSchema: MIGRATIONS_SCHEMA, migrationsTable: MIGRATIONS_TABLE });
      timings.migrateNoop = Math.round(performance.now() - tm);
      const ledger = (await db2.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(MIGRATIONS_SCHEMA)}.${sql.identifier(MIGRATIONS_TABLE)}`)).rows[0]!.n;
      assert(ledger === 1, `migration ledger has ${ledger} rows after re-run (expected 1 — idempotent)`);
      const a = await db2.query.article.findFirst({ where: eq(article.slug, 'humans-are-software') });
      assert(a?.topic === 'from-t1', 'article did not persist across reopen');
    } finally {
      await reopened.close();
    }
    return `reopen ${timings.reopen} ms, no-op migrate ${timings.migrateNoop} ms, data dir ${mb(timings.diskBytes)}`;
  });

  await probe('risk #11  two PGlite instances on ONE dir (simulates two processes / dev workers)', async () => {
    // Run last, on the throwaway dir: PGlite 0.3 has no cross-instance lock, so this documents
    // whether a second opener is rejected. Either outcome passes; the note is what matters.
    const first = new PGliteCtor(SPIKE_DIR);
    let second: PGlite | undefined;
    try {
      await first.waitReady;
      second = new PGliteCtor(SPIKE_DIR);
      await second.waitReady;
      const r = await second.query<{ n: number }>('select count(*)::int as n from article');
      return `NOT rejected — second instance opened and read ${r.rows[0]!.n} row(s); no dir lock exists, so S2.8 must guarantee a single opener (globalThis cache; dev:design closes before next dev spawns)`;
    } catch (error) {
      return `second open rejected: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`;
    } finally {
      await second?.close().catch(() => {});
      await first.close().catch(() => {});
    }
  });

  await probe('in-memory PGlite (pglite://memory): open + migrate', async () => {
    const t = performance.now();
    const mem = new PGliteCtor();
    await mem.waitReady;
    const openMs = Math.round(performance.now() - t);
    try {
      const dbm = drizzle(mem, { schema });
      const tm = performance.now();
      await migrate(dbm, { migrationsFolder: MIGRATIONS_FOLDER, migrationsSchema: MIGRATIONS_SCHEMA, migrationsTable: MIGRATIONS_TABLE });
      const ms = Math.round(performance.now() - tm);
      const [r] = (await dbm.execute<{ ok: number }>(sql`select 1 as ok`)).rows;
      assert(r?.ok === 1, 'select 1 failed');
      return `open ${openMs} ms, migrate ${ms} ms`;
    } finally {
      await mem.close();
    }
  });

  if (client) await (client as PGlite).close().catch(() => {});

  const failed = results.filter((r) => !r.ok);
  const totalMs = Math.round(performance.now() - wall);
  console.log('');
  console.log(`PGlite ${pgliteVersion} · server_version ${pgVersion}`);
  console.log(
    `cold start: import ${timings.import ?? '?'} ms + initdb ${timings.initdb ?? '?'} ms + migrate ${migrateMs} ms · reopen ${timings.reopen ?? '?'} ms + no-op migrate ${timings.migrateNoop ?? '?'} ms`,
  );
  console.log(`on disk (after all probes, closed): ${timings.diskBytes ? mb(timings.diskBytes) : '?'} · wall ${totalMs} ms`);
  console.log(`${results.length - failed.length}/${results.length} probes passed`);
  console.log(failed.length === 0 ? 'VERDICT: GO' : `VERDICT: NO-GO (${failed.map((f) => f.name).join('; ')})`);
  console.log(`spike dir: ${SPIKE_DIR} (delete with: rm -rf var/pglite-spike)`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(`spike:pglite failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});
