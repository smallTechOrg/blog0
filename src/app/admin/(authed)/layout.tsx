import { cookies } from 'next/headers';
import type { ReactNode } from 'react';

import { DeskHeader } from '@/components/admin/DeskHeader';
import { getAiProvider } from '@/server/ai/provider';
import { SESSION_COOKIE_NAME, validateSessionToken } from '@/server/auth/session';
import { getCurrentSite } from '@/server/site/current';

// Authenticated admin chrome: DeskHeader + page. A layout cannot see the pathname, so each page
// calls requireAdminPage(<its own path>) and a signed-out writer lands on
// /admin/login?next=<that path>. Without a session the layout renders no chrome at all, and
// every admin API answers 401, so nothing leaks while the page's redirect fires.

export const dynamic = 'force-dynamic';

export default async function AuthedAdminLayout({ children }: { children: ReactNode }) {
  const site = await getCurrentSite();
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value ?? null;
  const user = token ? ((await validateSessionToken(token, site.id))?.user ?? null) : null;
  if (!user) return <>{children}</>;
  // SMA-44: a failing AI provider is shown to the admin on every desk page, not only on a failed call.
  const ai = await getAiProvider(site.id);
  const aiProblem = ai.keyUnreadable
    ? 'The saved AI provider key can’t be read (the server secret changed) — enter it again.'
    : ai.configured && ai.status.failing
      ? `The AI provider is failing: ${ai.status.lastErrorMessage ?? ai.status.lastErrorCode ?? 'unknown error'}`
      : null;
  return (
    <div className="desk">
      <DeskHeader wordmark={site.wordmark} userName={user.displayName} />
      {aiProblem ? (
        <p className="aibanner" role="alert" data-testid="ai-banner">
          {aiProblem} <a href="/admin/site#ai">Check the AI provider</a>
        </p>
      ) : null}
      {children}
    </div>
  );
}
