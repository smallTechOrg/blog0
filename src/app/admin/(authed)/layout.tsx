import type { ReactNode } from 'react';

import { DeskHeader } from '@/components/admin/DeskHeader';

import { loadAdminContext } from './_lib/admin-context';

// Authenticated admin chrome: DeskHeader + page. A layout cannot see the pathname, so each page
// calls requireAdminPage(<its own path>) and a signed-out writer lands on
// /admin/login?next=<that path>. Without a session the layout renders no chrome at all, and
// every admin API answers 401, so nothing leaks while the page's redirect fires.

export const dynamic = 'force-dynamic';

export default async function AuthedAdminLayout({ children }: { children: ReactNode }) {
  const ctx = await loadAdminContext();
  if (!ctx.user) return <>{children}</>;
  return (
    <div className="desk">
      <DeskHeader wordmark={ctx.wordmark} userName={ctx.user.displayName} />
      {children}
    </div>
  );
}
