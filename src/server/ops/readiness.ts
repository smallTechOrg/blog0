import 'server-only';

import { getDbHandle } from '../db/client';
import { getMigrationStatus } from '../db/migrate';
import type { DbEngine } from '../db/url';
import { log } from '../log';
import { isShuttingDown } from './lifecycle';

// Readiness (capability container-image; spec/architecture.md §12.2): ready = not shutting down
// AND the DB answers AND no migration is pending. The DB ping and the migration check share one
// 3 s budget. A driver error is logged server-side only (as /api/health does), never returned.

export const READINESS_BUDGET_MS = 3000;

export type NotReadyReason = 'SHUTTING_DOWN' | 'DB_UNAVAILABLE' | 'MIGRATIONS_PENDING';

export type ReadinessResult =
  | {
      ready: true;
      dbLatencyMs: number;
      engine: DbEngine;
      applied: number;
      latest: string | null;
    }
  | { ready: false; reason: NotReadyReason; pending?: string[] };

class BudgetExceeded extends Error {
  constructor() {
    super(`database did not answer within ${READINESS_BUDGET_MS} ms`);
    this.name = 'BudgetExceeded';
  }
}

function withinBudget<T>(work: Promise<T>, deadline: number): Promise<T> {
  const remaining = Math.max(0, deadline - performance.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BudgetExceeded()), remaining);
  });
  // A late rejection of the losing promise must not surface as an unhandled rejection.
  work.catch(() => {});
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export async function checkReadiness(opts: { requestId?: string } = {}): Promise<ReadinessResult> {
  if (isShuttingDown()) return { ready: false, reason: 'SHUTTING_DOWN' };

  const started = performance.now();
  const deadline = started + READINESS_BUDGET_MS;
  let dbLatencyMs: number;
  let engine: DbEngine;
  let status: Awaited<ReturnType<typeof getMigrationStatus>>;
  try {
    const handle = getDbHandle();
    engine = handle.engine;
    await withinBudget(handle.ping(), deadline);
    dbLatencyMs = Math.round(performance.now() - started);
    status = await withinBudget(getMigrationStatus(handle), deadline); // the app handle stays open
  } catch (error) {
    log.error('error', {
      msg: 'Readiness check could not reach the database',
      request_id: opts.requestId,
      err_code: 'DB_UNAVAILABLE',
      err_message: error instanceof Error ? error.message : String(error),
      err_stack: process.env.NODE_ENV === 'production' || !(error instanceof Error) ? undefined : error.stack,
    });
    return { ready: false, reason: 'DB_UNAVAILABLE' };
  }

  // A signal may have arrived while the DB answered.
  if (isShuttingDown()) return { ready: false, reason: 'SHUTTING_DOWN' };
  if (status.pending.length > 0) return { ready: false, reason: 'MIGRATIONS_PENDING', pending: status.pending };
  return { ready: true, dbLatencyMs, engine, applied: status.applied.length, latest: status.latestApplied };
}
