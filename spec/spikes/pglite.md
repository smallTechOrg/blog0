# S2.0 PGlite spike — verdict

**VERDICT: GO** — designer mode uses embedded PGlite behind the same Drizzle API as specified in
`spec/architecture.md` §11.1–11.2. The §11.5 file-backed fallback is **not** needed.

Run: `pnpm spike:pglite` (`scripts/spike-pglite.ts`) on 2026-10-12, darwin arm64, Node 22.
Result: **25/25 probes PASS**, exit 0. The spike dir `var/pglite-spike` is wiped at start and was
deleted after the run.

## Versions

| Item | Value |
|---|---|
| `@electric-sql/pglite` | **0.3.16** (installed, `^0.3.16`) — sufficient; **no upgrade needed** |
| `drizzle-orm` | 0.45.4 — ships `drizzle-orm/pglite` + `drizzle-orm/pglite/migrator`; peer range `@electric-sql/pglite >=0.2.0` |
| `server_version` | `17.5` |
| `version()` | `PostgreSQL 17.5 on aarch64-unknown-linux-gnu, compiled by emcc (…) 3.1.74 (…), 32-bit` |
| `current_database()` | `template1` (not `blog0`) |

PGlite 0.5.x is **not** required: every probe passed on 0.3.16 with drizzle-orm 0.45.4. Stay on
0.3.x; a jump to 0.5 would need this spike re-run.

## Timing and size (this machine)

| Step | Time |
|---|---|
| `import('@electric-sql/pglite')` (module + WASM) | 262 ms |
| `new PGlite(<fresh dir>)` → `waitReady` (initdb, first boot only) | 1502 ms |
| `migrate()` 0000_init on a fresh cluster | 135 ms |
| **First-ever cold start total** (import + initdb + migrate) | **≈ 1.9 s** |
| Reopen an existing dir → `waitReady` | 85 ms |
| No-op `migrate()` on an up-to-date dir | 3 ms |
| In-memory `new PGlite()` → `waitReady` / migrate | 381 ms / 30 ms |
| `select 1` ping | ≈ 0.2 ms |
| Full spike wall | 4.6 s |

On disk: **26.4 MB** for the empty cluster after initdb; **27.1 MB** after migrate + all probe data
(closed). `var/` is already the home for this — keep `var/pglite*` gitignored.

## §11.3 risk table — results

| # | Construct | Result |
|---|---|---|
| 1 | `gen_random_uuid()` / `now()` defaults; insert without id | PASS — uuid id, `Date` timestamps, text defaults applied |
| 2 | 0000_init.sql verbatim via `drizzle-orm/pglite/migrator`, same folder/`drizzle.__drizzle_migrations` | PASS — 9 tables, 10/10 indexes (`DESC NULLS LAST` preserved), 4 public CHECKs, FK `cascade` (session on user delete) and `set null` (article.current_revision_id on revision delete) |
| 3 | `.for('update')` via the real `repo.ts lockArticle` | PASS — parses, returns the row inside a tx. Semantics below |
| 4 | `db.transaction` commit + throw-rollback; Generate-lock tx (lock → insert `ai_generation` running → commit) | PASS |
| 5 | `onConflictDoUpdate({ target, set, setWhere })` ×2 inside tx (upsertDraft shape) | PASS — insert → update → `setWhere` mismatch is a silent no-op, 1 row |
| 6 | `onConflictDoNothing({ target })`; real `seedSite` ×2 + `seedAdmin` ×2 (argon2) | PASS — created → ok both |
| 7 | `getMigrationStatus` queries through `db.execute(sql…)` + `sql.identifier()`; `to_regclass(...)` returns boolean | PASS |
| 8 | health `select 1` through drizzle | PASS |
| 9 | Postgres-only paths (`create database`, `pg_database`) | n/a — not used in designer mode |
| 10 | Next/Turbopack bundling of PGlite (`next build && next start` on 3414) | **NOT RUN here** (spike was scoped to no server). S2.8 owns it: add `'@electric-sql/pglite'` to `serverExternalPackages` and prove `/api/health` + `/p/humans-are-software` on a `pglite://` build |
| 11 | Two instances on one dir | No lock: a second `new PGlite(sameDir)` opens and reads without error → single-opener discipline is mandatory (see quirks) |
| 12 | drizzle-kit | unchanged — `generate` needs no DB |
| 13 | `numeric(12,6, mode:'number')`, `text[]` default `'{}'`, `jsonb` | PASS — `costUsd` is `number` (0.001234), `provider_generation_ids` is `string[]` (`[]` by default), jsonb round-trips; same via RETURNING and plain SELECT |

Also PASS: session insert/select/update with ms-precision `timestamptz` round-trip (auth/session.ts
shape, join on `app_user`); reader-shape join `article ⋈ revision ⋈ format` ordered
`first_published_at desc nulls last`; `selectDistinctOn` via the real `latestGeneration`; the
running-row guard (tldr.ts step 2: young `running` row → `GENERATION_IN_PROGRESS`, tx rolled back;
stale → allowed); SQLSTATE codes reach `service.ts pgCode()` unchanged (`23505`, `23514` on
`error.cause.code` of drizzle's `DrizzleQueryError`); close/reopen persistence with an idempotent
ledger (1 row); `pglite://memory`.

## FOR UPDATE semantics on PGlite (document in S2.8)

PGlite is one backend with one session. `drizzle-orm/pglite` maps `db.transaction()` to
`client.transaction()`, which holds an **in-process mutex for the entire callback**:

- Two concurrent `db.transaction()` calls run **strictly one after another** — the second
  callback does not start until the first commits (observed: `t1-start → t1-end → t2-start →
  t2-saw:from-t1`). `SELECT … FOR UPDATE` never has a second session to block, so the row lock is a
  no-op; the exclusion comes from the mutex, which is stronger (whole-database).
- A plain `db.select()` issued while a tx is open **waits** for the commit (no dirty read, no
  interleave).
- So the Generate double-click guard is still correct in designer mode: the second click's tx runs
  after the first committed its `running` row and is refused by `isGenerationActive`. The guard
  relies on the `running` row, exactly as §11.3 #3 planned.
- Consequence: never hold a tx open across slow work (the LLM call). tldr.ts already calls the model
  outside any transaction (step 3) — keep it that way; it now also blocks *every* request in
  designer mode, not just one article.

## Quirks S2.8 must handle

1. **Deadlock: outer `db` inside a tx callback.** A query on the outer handle (`getDb()`, or a repo
   function whose `db: Executor = getDb()` default kicks in because `tx` was not passed) issued
   inside a `db.transaction` callback **never resolves** on PGlite (it queues behind the tx mutex
   the callback holds). Proven by the spike (1.5 s timeout). On postgres-js it silently uses a
   second pooled connection, so the suite on Postgres will not catch it. Audit every
   `transaction(async (tx) => …)` body in `src/server/**` and ensure every DB-touching call receives
   `tx` (`articles/tldr.ts`, `articles/service.ts`, `site/*`, newsletter, etc.); `renderRevision`
   in `articles/views.ts` must stay DB-free or take `tx`. The designer-mode integration test should
   run at least one Generate-lock/save/publish path end-to-end on `pglite://memory` to catch this.
2. **No directory lock.** Two `PGlite` instances (two processes, or two module graphs in Next dev)
   can open the same dir with no error; two writers on one data dir risk corrupting it (not tested destructively). Keep the `globalThis` single-instance
   cache; `dev:design` must finish migrate/seed and `close()` before spawning `next dev`; never
   run `db:migrate`/`db:seed` against `pglite://var/pglite` while the dev server is up (README note).
3. **`db.execute` result shape differs per driver.** pglite → `{ rows, fields, affectedRows }`;
   postgres-js → `RowList` (an array). Any `db.execute` consumer must read through a helper (e.g.
   `rowsOf(res) = Array.isArray(res) ? res : res.rows`). Current consumers: the new
   `getMigrationStatus`, and `tests/integration/auth.test.ts:153` (casts to an array — Postgres-only
   test, fine as-is).
4. **`current_database()` is `template1`.** `db:verify` should print `pglite:<dir>` instead of the
   database name for the pglite engine. `server_version` is plain `17.5` (no `(PGlite)` suffix) — the
   roadmap's expected `db:verify` line `PostgreSQL 17.x (PGlite)` must be composed by the script
   from the engine, not read from the server.
5. **`@electric-sql/pglite/package.json` is not exported** — read the version from disk if needed.
6. **pg_constraint includes `information_schema` domain CHECKs** (`cardinal_number_domain_check`,
   `yes_or_no_check`) — any constraint audit must filter `nspname = 'public'` (true on Postgres too).
7. **Cold start**: first boot ≈ 1.9 s (initdb 1.5 s), later boots ≈ 0.35 s (import + reopen) — fine
   for `dev:design`; no warm-up workaround needed. Close the instance on shutdown (`closeDb()`) for a clean
   checkpoint.

## Exact API-level changes for S2.8

1. **`src/server/db/client.ts`** — `Db = PgDatabase<PgQueryResultHKT, typeof schema>` from
   `drizzle-orm/pg-core`; `Tx = Parameters<Parameters<Db['transaction']>[0]>[0]`. Verified at
   compile time by the spike: both `PgliteDatabase<typeof schema>` and
   `PostgresJsDatabase<typeof schema>` assign to it without casts. `getDb()` keeps its signature.
   Add `getDbHandle()` / `createDbHandle(target)` / `closeDb()` per §11.2; one PGlite instance per
   process on `globalThis`. **Remove `getSql()` and `createSqlClient` from the public surface**
   (move the postgres.js factory into `postgres.ts`).
2. **`src/server/db/pglite.ts`** — `const { PGlite } = await import('@electric-sql/pglite')`
   (dynamic, so the Postgres path never loads the WASM); `new PGlite(dir)` / `new PGlite()` for
   `memory`; `await client.waitReady`; `drizzle(client, { schema })` from `drizzle-orm/pglite`;
   `ping = () => db.execute(sql\`select 1\`)`; `close = () => client.close()`.
3. **`src/server/db/migrate.ts`** — `runMigrations(target)` picks
   `drizzle-orm/postgres-js/migrator` or `drizzle-orm/pglite/migrator` by engine, same
   `migrationsFolder` / `migrationsSchema: 'drizzle'` / `migrationsTable: '__drizzle_migrations'`.
   `getMigrationStatus` takes a `DbHandle` and replaces the three postgres.js tagged templates:
   - ``sql`select current_database() as database, current_setting('server_version') as server_version` ``
     → ``db.execute(sql`…same…`)``
   - ``to_regclass(${'drizzle.__drizzle_migrations'}) is not null as exists`` → same text in
     ``db.execute(sql`…`)`` (parameter binding works; returns a JS boolean on PGlite)
   - ``${sql(MIGRATIONS_SCHEMA)}.${sql(MIGRATIONS_TABLE)}`` →
     ``${sql.identifier(MIGRATIONS_SCHEMA)}.${sql.identifier(MIGRATIONS_TABLE)}``
   and reads rows through the driver-neutral `rowsOf()` helper (quirk 3).
4. **`src/app/api/health/route.ts`** — `getSql()\`select 1 as ok\`` → `getDbHandle().ping()`
   inside the same `Promise.race` timeout; add `dbEngine` to the DTO per spec.
5. **Scripts** (`db-seed.ts`, `create-admin.ts`, `db-migrate.ts`, `db-verify.ts`) — replace
   `createSqlClient(url,{max:1})` + `drizzle(sql)` + `sql.end()` with
   `createDbHandle(parseDatabaseUrl(raw))` + `handle.close()`. `seedSite` / `seedAdmin` already run
   unchanged on PGlite once `Db` is the neutral type (proven).
6. **`next.config.ts`** — add `'@electric-sql/pglite'` to `serverExternalPackages` and prove a
   `next build && next start` on `pglite://` (risk #10, not covered by this spike).
7. **FOR UPDATE / transactions** — no code change; `lockArticle` works as-is. Add the tx-body audit
   from quirk 1, and a code comment on `lockArticle` noting that on PGlite the exclusion comes from
   the transaction mutex.
8. **The spike script** — once S2.8 lands, the spike's `asServiceDb`/`asServiceTx` casts
   become unnecessary (the neutral type makes them identity); the spike itself needs no update to
   keep passing.
