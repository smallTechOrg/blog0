import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { LinkActionButton } from '@/components/site/newsletter/LinkActionButton';
import { peekConfirmToken } from '@/server/newsletter/service';
import { pageTitle } from '@/server/public/metadata';
import { getCurrentSite } from '@/server/site/current';

// GET /newsletter/confirm?t=<token> (spec/api.md → newsletter; spec/ui.md §3): the emailed link.
// Fix pass (scanner-safe): the GET NEVER changes state, consumes a token or counts toward a cap — it
// only shape-checks the token (malformed → true 404 via notFound() → this segment's not-found.tsx)
// and renders the button; the client component POSTs the token to /api/newsletter/confirm and shows
// the outcome (subscribed / expired or used / invalid / rate limited).

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const site = await getCurrentSite();
  return { title: pageTitle('Subscription', site.wordmark), robots: { index: false, follow: false } };
}

interface PageProps {
  searchParams: Promise<{ t?: string | string[] }>;
}

export default async function ConfirmPage({ searchParams }: PageProps) {
  const { t } = await searchParams;
  const token = typeof t === 'string' ? t : '';
  if (!peekConfirmToken(token)) notFound();

  const site = await getCurrentSite();
  return <LinkActionButton kind="confirm" token={token} brand={site.wordmark} brandName={site.brandName} />;
}
