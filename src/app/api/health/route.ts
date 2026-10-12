import type { HealthDto } from '@/lib/api/dto';
import { APP_VERSION } from '@/server/config';
import { getSql } from '@/server/db/client';
import { ApiError, withApi } from '@/server/http/api';

// GET /api/health — proves the process is up and Postgres answers (spec/api.md → Scaffold).

export const dynamic = 'force-dynamic';

const DB_TIMEOUT_MS = 3000;

async function pingDb(): Promise<number> {
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`database did not answer within ${DB_TIMEOUT_MS} ms`)), DB_TIMEOUT_MS);
  });
  try {
    await Promise.race([getSql()`select 1 as ok`, timeout]);
  } finally {
    clearTimeout(timer);
  }
  return Math.round(performance.now() - started);
}

export const GET = withApi({ auth: 'none' }, async (): Promise<HealthDto> => {
  let dbLatencyMs: number;
  try {
    dbLatencyMs = await pingDb();
  } catch (error) {
    throw new ApiError('DB_UNAVAILABLE', 503, 'The database is not reachable — check BLOG0_DATABASE_URL and that Postgres is running.', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
  }
  return {
    status: 'ok',
    db: 'ok',
    dbLatencyMs,
    version: APP_VERSION,
    uptimeSec: Math.round(process.uptime()),
  };
});
