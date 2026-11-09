import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { LinkActionButton } from '@/components/site/newsletter/LinkActionButton';
import { peekUnsubscribeToken } from '@/server/newsletter/service';
import { pageTitle } from '@/server/public/metadata';
import { getCurrentSite } from '@/server/site/current';

// GET /newsletter/unsubscribe?t=<signed token> (spec/api.md → newsletter). Fix pass (scanner-safe):
// the GET changes nothing and counts toward no cap — it checks the token's shape and signature
// (bad → true 404 through this segment's not-found.tsx) and renders "Yes, unsubscribe me"; the
// client component POSTs { token, source: 'email_link' } to /api/newsletter/unsubscribe and shows
// the outcome (idempotent for an already-unsubscribed address).

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const site = await getCurrentSite();
  return { title: pageTitle('Subscription', site.wordmark), robots: { index: false, follow: false } };
}

interface PageProps {
  searchParams: Promise<{ t?: string | string[] }>;
}

export default async function UnsubscribePage({ searchParams }: PageProps) {
  const { t } = await searchParams;
  const token = typeof t === 'string' ? t : '';
  if (!peekUnsubscribeToken(token)) notFound();

  const site = await getCurrentSite();
  return <LinkActionButton token={token} brand={site.wordmark} brandName={site.brandName} />;
}
