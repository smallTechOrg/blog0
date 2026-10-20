import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { LINK_COPY, LinkPage } from '@/components/site/newsletter/LinkPage';
import { CONFIRM_RESULT_STATUSES, type ConfirmResultStatus } from '@/server/newsletter/links';
import { pageTitle } from '@/server/public/metadata';
import { getCurrentSite } from '@/server/site/current';

// /newsletter/confirmed?status=ok|already|expired|invalid|limited[&m=<minutes>] — where the confirm
// link (GET /newsletter/confirm, a route handler that confirms on open) 303s to (spec/ui.md §3). Pure
// display: it reads no token and changes nothing. `invalid` (or a missing/unknown status) is a true
// 404 through this segment's not-found.tsx, as the old confirm page answered for a bad token.

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const site = await getCurrentSite();
  return { title: pageTitle('Subscription', site.wordmark), robots: { index: false, follow: false } };
}

interface PageProps {
  searchParams: Promise<{ status?: string | string[]; m?: string | string[] }>;
}

function statusOf(raw: string | string[] | undefined): ConfirmResultStatus | null {
  return typeof raw === 'string' && (CONFIRM_RESULT_STATUSES as readonly string[]).includes(raw) ? (raw as ConfirmResultStatus) : null;
}

/** Retry minutes for the rate-limited copy: a whole number in 1…1440, default 1. */
function retryMinutesOf(raw: string | string[] | undefined): number {
  const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) ? Math.min(1440, Math.max(1, n)) : 1;
}

export default async function ConfirmedPage({ searchParams }: PageProps) {
  const { status: rawStatus, m } = await searchParams;
  const status = statusOf(rawStatus);
  if (status === null || status === 'invalid') notFound();

  const site = await getCurrentSite();
  const copy =
    status === 'ok'
      ? { heading: LINK_COPY.confirmed.heading(site.brandName), body: LINK_COPY.confirmed.body(site.brandName) }
      : status === 'already'
        ? { heading: LINK_COPY.alreadyConfirmed.heading, body: LINK_COPY.alreadyConfirmed.body(site.brandName) }
        : status === 'expired'
          ? { heading: LINK_COPY.expired.heading, body: LINK_COPY.expired.body() }
          : { heading: LINK_COPY.rateLimited.heading, body: LINK_COPY.rateLimited.body(retryMinutesOf(m)) };
  return <LinkPage brand={site.wordmark} heading={copy.heading} body={copy.body} />;
}
