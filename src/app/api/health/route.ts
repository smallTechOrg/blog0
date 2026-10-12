import type { HealthPhase2Dto } from '@/lib/api/dto-phase2';
import { APP_VERSION } from '@/server/config';
import { getDbHandle } from '@/server/db/client';
import { ApiError, withApi } from '@/server/http/api';
import { log } from '@/server/log';

// GET /api/health — proves the process is up and the database answers (spec/api.md → Scaffold;
// `dbEngine` since Phase 2: 'postgres' or 'pglite' in designer mode).

export const dynamic = 'force-dynamic';

const DB_TIMEOUT_MS = 3000;

async function pingDb(): Promise<{ latencyMs: number; engine: HealthPhase2Dto['dbEngine'] }> {
  const started = performance.now();
  const handle = getDbHandle();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`database did not answer within ${DB_TIMEOUT_MS} ms`)), DB_TIMEOUT_MS);
  });
  try {
    await Promise.race([handle.ping(), timeout]);
  } finally {
    clearTimeout(timer);
  }
  return { latencyMs: Math.round(performance.now() - started), engine: handle.engine };
}

export const GET = withApi({ auth: 'none' }, async ({ requestId }): Promise<HealthPhase2Dto> => {
  let ping: Awaited<ReturnType<typeof pingDb>>;
  try {
    ping = await pingDb();
  } catch (error) {
    // The driver message can carry host, port, user or database names — server log only, never the client.
    log.error('error', {
      msg: 'Health check could not reach the database',
      request_id: requestId,
      err_code: 'DB_UNAVAILABLE',
      err_message: error instanceof Error ? error.message : String(error),
      err_stack: process.env.NODE_ENV === 'production' || !(error instanceof Error) ? undefined : error.stack,
    });
    throw new ApiError('DB_UNAVAILABLE', 503, 'The database is not reachable — check BLOG0_DATABASE_URL and that Postgres is running (or the PGlite data directory is intact).');
  }
  return {
    status: 'ok',
    db: 'ok',
    dbLatencyMs: ping.latencyMs,
    version: APP_VERSION,
    uptimeSec: Math.round(process.uptime()),
    dbEngine: ping.engine,
  };
});
