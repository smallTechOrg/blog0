import { cookies } from 'next/headers';
import type { ReactNode } from 'react';

import { DeskHeader } from '@/components/admin/DeskHeader';
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
  return (
    <div className="desk">
      <DeskHeader wordmark={site.wordmark} userName={user.displayName} />
      {children}
    </div>
  );
}
