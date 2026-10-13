import type { HealthLiveDto } from '@/lib/api/dto';
import { APP_VERSION } from '@/server/config';
import { withApi } from '@/server/http/api';
import { isShuttingDown } from '@/server/ops/lifecycle';

// GET /api/health/live — liveness probe + Docker HEALTHCHECK (spec/api.md → health). Answers 200
// while the process serves, also during the shutdown drain; never touches the DB or config.

export const dynamic = 'force-dynamic';

export const GET = withApi(
  { auth: 'none', logLevel: 'debug' },
  async (): Promise<HealthLiveDto> => ({
    status: 'live',
    version: APP_VERSION,
    uptimeSec: Math.round(process.uptime()),
    shuttingDown: isShuttingDown(),
  }),
);
