import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';

import { LINK_COPY, LinkPage } from '@/components/site/newsletter/LinkPage';
import { clientIpFromRequest } from '@/server/auth/login';
import { ApiError } from '@/server/http/api';
import { log } from '@/server/log';
import { checkLink } from '@/server/newsletter/link-guard';
import { unsubscribeByToken } from '@/server/newsletter/service';
import { isWellFormedUnsubscribeToken } from '@/server/newsletter/tokens';
import { pageTitle } from '@/server/public/metadata';
import { getCurrentSite } from '@/server/site/current';

// GET /newsletter/unsubscribe?t=<signed token> (spec/api.md → newsletter): one click, no sign-in.
// Unsubscribes at once and shows "You’re unsubscribed." — the same page for an already-unsubscribed
// address (no new suppression row). A bad signature is a 404 through this segment's not-found.tsx;
// the rate-limited copy renders at 200 (see confirm/page.tsx for why).

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
  if (!isWellFormedUnsubscribeToken(token)) notFound();

  const site = await getCurrentSite();
  const h = await headers();
  const request = new Request('http://blog0.local/newsletter/unsubscribe', { headers: h });
  const ip = clientIpFromRequest(request);
  const limited = await checkLink({ ip, siteId: site.id });
  if (limited.limited) {
    log.info('newsletter.link', { kind: 'unsubscribe', outcome: 'rate_limited' });
    return <LinkPage brand={site.wordmark} heading={LINK_COPY.rateLimited.heading} body={LINK_COPY.rateLimited.body(limited.retryMinutes)} />;
  }

  try {
    const result = await unsubscribeByToken(token, 'email_link', { ip, userAgent: h.get('user-agent') }, site);
    log.info('newsletter.link', { kind: 'unsubscribe', outcome: result.alreadyUnsubscribed ? 'already' : 'ok', subscriber_id: result.subscriber.id });
  } catch (err) {
    if (err instanceof ApiError && err.code === 'TOKEN_INVALID') {
      log.info('newsletter.link', { kind: 'unsubscribe', outcome: 'invalid' });
      notFound();
    }
    throw err;
  }
  return <LinkPage brand={site.wordmark} heading={LINK_COPY.unsubscribed.heading} body={LINK_COPY.unsubscribed.body()} />;
}
