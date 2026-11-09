import type { HealthReadyDto, NotReadyDetails } from '@/lib/api/dto';
import { APP_VERSION } from '@/server/config';
import { ApiError, withApi } from '@/server/http/api';
import { checkReadiness } from '@/server/ops/readiness';

// GET /api/health/ready — readiness probe (spec/api.md → health): DB answers within 3 s, no migration
// pending, not shutting down. Otherwise 503 NOT_READY with a fixed message per reason (never driver text).

export const dynamic = 'force-dynamic';

const MESSAGES: Record<NotReadyDetails['reason'], string> = {
  SHUTTING_DOWN: 'blog0 is shutting down and no longer accepts traffic.',
  DB_UNAVAILABLE: 'The database is not reachable — check BLOG0_DATABASE_URL and that Postgres is running.',
  MIGRATIONS_PENDING: 'The database schema is behind this version — run the release step (node release.mjs or pnpm release).',
};

export const GET = withApi({ auth: 'none', logLevel: 'debug' }, async ({ requestId }): Promise<HealthReadyDto> => {
  const result = await checkReadiness({ requestId });
  if (!result.ready) {
    const details: NotReadyDetails =
      result.pending === undefined ? { reason: result.reason } : { reason: result.reason, pending: result.pending };
    throw new ApiError('NOT_READY', 503, MESSAGES[result.reason], details);
  }
  return {
    status: 'ready',
    db: 'ok',
    dbLatencyMs: result.dbLatencyMs,
    dbEngine: result.engine,
    migrations: { applied: result.applied, pending: 0, latest: result.latest },
    version: APP_VERSION,
  };
});
