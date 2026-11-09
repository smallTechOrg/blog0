import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import '@/styles/admin.css';

// Every admin page, sign-in included, gets admin.css (spec/ui.md §4). The wrapper lifts the
// content above the design's page texture (body::before), like #blog0-root does for the site,
// without the site's print-in hold.

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }: { children: ReactNode }) {
  return <div className="admin-root">{children}</div>;
}
