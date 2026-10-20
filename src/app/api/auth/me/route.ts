import type { MeResponse } from '@/lib/api/dto';
import { withApi } from '@/server/http/api';

// GET /api/auth/me — the signed-in admin (spec/api.md); 401 UNAUTHENTICATED without a session.

export const dynamic = 'force-dynamic';

export const GET = withApi({ auth: 'admin' }, async ({ auth }): Promise<MeResponse> => ({
  user: { id: auth.user.id, email: auth.user.email, displayName: auth.user.displayName },
}));
