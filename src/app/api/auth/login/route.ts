import { z } from 'zod';

import type { LoginResponse } from '@/lib/api/dto';
import { clientIpFromRequest, login } from '@/server/auth/login';
import { PASSWORD_MAX_LENGTH } from '@/server/auth/password';
import { serializeSessionCookie } from '@/server/auth/session';
import { apiResult, withApi } from '@/server/http/api';
import { maskEmail } from '@/server/log';
import { getCurrentSite } from '@/server/site/current';

// POST /api/auth/login — { email, password } → { user } + Set-Cookie blog0_session (spec/api.md).
// Errors: 400 VALIDATION_FAILED, 401 BAD_CREDENTIALS, 429 RATE_LIMITED (+ Retry-After),
// 403 FORBIDDEN_ORIGIN (cross-site POST).

export const dynamic = 'force-dynamic';

const LoginBody = z.object({
  email: z.string().trim().max(254).pipe(z.email()),
  // Policy minimum (12) is enforced at creation; a shorter password simply cannot match.
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});

export const POST = withApi(
  {
    auth: 'none',
    body: LoginBody,
    summarizeInput: (body) => ({ email_masked: maskEmail(body.email.toLowerCase()) }),
    summarizeOutput: (data) => ({ user_id: (data as LoginResponse).user.id }),
  },
  async ({ request, requestId, body }) => {
    const site = await getCurrentSite();
    const result = await login({
      siteId: site.id,
      email: body.email,
      password: body.password,
      ip: clientIpFromRequest(request),
      userAgent: request.headers.get('user-agent'),
      requestId,
    });
    const data: LoginResponse = { user: result.user };
    return apiResult(data, { headers: [['set-cookie', serializeSessionCookie(result.token, result.expiresAt, result.issuedAt)]] });
  },
);
