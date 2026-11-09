import 'server-only';

import { createHash } from 'node:crypto';

import { and, asc, eq, lte, or, sql, type SQL } from 'drizzle-orm';

import { delayDecision, LOGIN_DELAY_RESET_MS } from './auth/login-delay';
import { getConfig, type Config } from './config';
import { getDb, type Db, type Tx } from './db/client';
import { rateLimitBucket } from './db/schema';
import { log } from './log';
import { MemoryRateLimitStore, type RateBucket, type RateCheck, type RateLimitStore } from './rate-window';

// Postgres-backed throttle store + store selection (spec/architecture.md §6, capability
// abuse-protection, table spec/data.md → rate_limit_bucket).
//
// One transaction per attempt: ensure the window rows exist (count 0), lock them in a fixed order
// (scope, key_hash) so concurrent attempts never deadlock, refuse when any is at its cap (nothing
// counted), else +1 in all. N concurrent attempts against a cap of M therefore admit exactly M —
// across processes, because the row lock lives in the database. Windows are epoch-aligned
// (floor(now / window) × window). DB errors propagate: the caller answers 500 (fail closed).

export const PRUNE_INTERVAL_MS = 10 * 60 * 1000;

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Start of the fixed window containing `now` (UTC epoch-aligned). */
export function windowStartFor(now: number, windowMs: number): number {
  return Math.floor(now / windowMs) * windowMs;
}

interface WindowRow {
  siteId: string;
  scope: string;
  keyHash: string;
  windowStart: Date;
  expiresAt: Date;
}

function windowRow(siteId: string, bucket: RateBucket, now: number): WindowRow {
  const start = windowStartFor(now, bucket.windowMs);
  return {
    siteId,
    scope: bucket.scope,
    keyHash: sha256Hex(bucket.key),
    windowStart: new Date(start),
    expiresAt: new Date(start + bucket.windowMs),
  };
}

/** The constant window of a `login.delay` row (epoch 0); its `expires_at` carries the timing. */
export const DELAY_WINDOW_START = new Date(0);

function delayRow(siteId: string, key: string): Omit<WindowRow, 'expiresAt'> {
  return { siteId, scope: 'login.delay', keyHash: sha256Hex(key), windowStart: DELAY_WINDOW_START };
}

function matchRow(row: Omit<WindowRow, 'expiresAt'>): SQL {
  return and(
    eq(rateLimitBucket.siteId, row.siteId),
    eq(rateLimitBucket.scope, row.scope),
    eq(rateLimitBucket.keyHash, row.keyHash),
    eq(rateLimitBucket.windowStart, row.windowStart),
  ) as SQL;
}

const lastPruneKey = Symbol.for('blog0.rateLimitLastPrune');
type GlobalWithPrune = typeof globalThis & { [lastPruneKey]?: number };

/** Machine-readable error code for the prune-failure log (never the message text). */
function errCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(code)) return code;
  return err instanceof Error && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : 'unknown';
}

export class DbRateLimitStore implements RateLimitStore {
  readonly kind = 'db' as const;
  readonly #db: Db | null;

  /** `db` defaults to the app handle (`getDb()`, resolved per call so a reset handle is picked up). */
  constructor(db?: Db) {
    this.#db = db ?? null;
  }

  #handle(): Db {
    return this.#db ?? getDb();
  }

  async attempt(siteId: string, buckets: readonly RateBucket[], now: number): Promise<RateCheck> {
    if (buckets.length === 0) return { limited: false };
    const rows = buckets.map((b) => ({ bucket: b, row: windowRow(siteId, b, now) }));
    // Fixed lock order (scope, key_hash) — the same order for every caller, so no deadlock.
    rows.sort((a, b) => (a.row.scope === b.row.scope ? cmp(a.row.keyHash, b.row.keyHash) : cmp(a.row.scope, b.row.scope)));

    const result = await this.#handle().transaction(async (tx: Tx): Promise<RateCheck> => {
      await tx
        .insert(rateLimitBucket)
        .values(rows.map(({ row }) => ({ ...row, count: 0 })))
        .onConflictDoNothing();
      const locked = await tx
        .select({
          scope: rateLimitBucket.scope,
          keyHash: rateLimitBucket.keyHash,
          count: rateLimitBucket.count,
          expiresAt: rateLimitBucket.expiresAt,
        })
        .from(rateLimitBucket)
        .where(or(...rows.map(({ row }) => matchRow(row))))
        .orderBy(asc(rateLimitBucket.scope), asc(rateLimitBucket.keyHash))
        .for('update');

      let worst: RateCheck = { limited: false };
      for (const { bucket, row } of rows) {
        const current = locked.find((l) => l.scope === row.scope && l.keyHash === row.keyHash);
        const count = current?.count ?? 0;
        if (count < bucket.max) continue;
        const endsAt = (current?.expiresAt ?? row.expiresAt).getTime();
        const wait = Math.max(1, Math.ceil((endsAt - now) / 1000));
        if (!worst.limited || wait > worst.retryAfterSec) worst = { limited: true, retryAfterSec: wait, scope: bucket.scope };
      }
      if (worst.limited) return worst;

      await tx
        .update(rateLimitBucket)
        .set({ count: sql`${rateLimitBucket.count} + 1` })
        .where(or(...rows.map(({ row }) => matchRow(row))));
      return worst;
    });

    await this.#maybePrune(now);
    return result;
  }

  /**
   * Stage A progressive delay (spec/architecture.md §6), no migration: one row per key with scope
   * `login.delay`, `window_start` = epoch 0 (constant), `count` = attempts since the last success,
   * `expires_at` = last attempt + 15 min (so an idle key is reset by expiry and removed by the prune).
   * One transaction: upsert → lock → expired ⇒ n = 0 → wait check → n + 1, expires_at = now + 15 min.
   */
  async attemptDelay(siteId: string, key: string, now: number): Promise<RateCheck> {
    const row = delayRow(siteId, key);
    const result = await this.#handle().transaction(async (tx: Tx): Promise<RateCheck> => {
      await tx
        .insert(rateLimitBucket)
        .values({ ...row, expiresAt: new Date(now), count: 0 })
        .onConflictDoNothing();
      const [locked] = await tx
        .select({ count: rateLimitBucket.count, expiresAt: rateLimitBucket.expiresAt })
        .from(rateLimitBucket)
        .where(matchRow(row))
        .for('update');
      const live = locked !== undefined && locked.expiresAt.getTime() > now;
      const n = live ? locked.count : 0;
      const decision = delayDecision(n, live ? locked.expiresAt.getTime() - LOGIN_DELAY_RESET_MS : null, now);
      if (decision.limited) return { limited: true, retryAfterSec: decision.retryAfterSec, scope: 'login.delay' };
      await tx
        .update(rateLimitBucket)
        .set({ count: n + 1, expiresAt: new Date(now + LOGIN_DELAY_RESET_MS) })
        .where(matchRow(row));
      return { limited: false };
    });
    await this.#maybePrune(now);
    return result;
  }

  async clearDelay(siteId: string, key: string): Promise<void> {
    await this.#handle().delete(rateLimitBucket).where(matchRow(delayRow(siteId, key)));
  }

  async refund(siteId: string, bucket: RateBucket, now: number): Promise<void> {
    const row = windowRow(siteId, bucket, now);
    await this.#handle()
      .update(rateLimitBucket)
      .set({ count: sql`greatest(${rateLimitBucket.count} - 1, 0)` })
      .where(matchRow(row));
  }

  async clear(siteId: string, bucket: RateBucket, now: number): Promise<void> {
    await this.#handle().delete(rateLimitBucket).where(matchRow(windowRow(siteId, bucket, now)));
  }

  async prune(now: number): Promise<number> {
    const deleted = await this.#handle()
      .delete(rateLimitBucket)
      .where(lte(rateLimitBucket.expiresAt, new Date(now)))
      .returning({ siteId: rateLimitBucket.siteId });
    return deleted.length;
  }

  /** At most once per PRUNE_INTERVAL_MS per process; a failure is logged and never fails the request. */
  async #maybePrune(now: number): Promise<void> {
    const g = globalThis as GlobalWithPrune;
    const last = g[lastPruneKey];
    if (last !== undefined && Math.abs(now - last) < PRUNE_INTERVAL_MS) return;
    g[lastPruneKey] = now;
    try {
      await this.prune(now);
    } catch (err) {
      log.warn('rate_limit.prune_failed', { msg: 'Pruning expired throttle windows failed', err_code: errCode(err) });
    }
  }
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------
// Selection: BLOG0_RATE_LIMIT_STORE auto → db on postgres://, memory on pglite://; db/memory force.

export function createRateLimitStore(config: Pick<Config, 'rateLimitStore' | 'dbEngine'>): RateLimitStore {
  const kind = config.rateLimitStore === 'auto' ? (config.dbEngine === 'postgres' ? 'db' : 'memory') : config.rateLimitStore;
  return kind === 'db' ? new DbRateLimitStore() : new MemoryRateLimitStore();
}

const storeKey = Symbol.for('blog0.rateLimitStore');
type GlobalWithStore = typeof globalThis & { [storeKey]?: RateLimitStore };

/** The process-wide store (on globalThis so dev-mode module reloads share it). */
export function getRateLimitStore(): RateLimitStore {
  const g = globalThis as GlobalWithStore;
  g[storeKey] ??= createRateLimitStore(getConfig());
  return g[storeKey];
}

/** Replaces the store (tests opt into the DB store with `new DbRateLimitStore()`); no argument → re-select from config. */
export function resetRateLimitStoreForTests(store?: RateLimitStore): void {
  (globalThis as GlobalWithStore)[storeKey] = store;
  (globalThis as GlobalWithPrune)[lastPruneKey] = undefined;
}

/** The current store without creating one (undefined before first use). */
export function peekRateLimitStore(): RateLimitStore | undefined {
  return (globalThis as GlobalWithStore)[storeKey];
}
