import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';

import { LINK_COPY, LinkPage } from '@/components/site/newsletter/LinkPage';
import { clientIpFromRequest } from '@/server/auth/login';
import { ApiError } from '@/server/http/api';
import { log } from '@/server/log';
import { checkLink } from '@/server/newsletter/link-guard';
import { confirmByToken } from '@/server/newsletter/service';
import { isWellFormedConfirmToken } from '@/server/newsletter/tokens';
import { pageTitle } from '@/server/public/metadata';
import { getCurrentSite } from '@/server/site/current';

// GET /newsletter/confirm?t=<token> (spec/api.md → newsletter; spec/ui.md §3): the emailed link.
// A server component in the site chrome calling confirmByToken directly. Outcomes: subscribed
// (200), invalid token (404 — notFound() → this segment's not-found.tsx carries the copy), expired
// or already used, rate limited. Next's App Router fixes a page's status at 200 except through
// notFound(), so the expired and rate-limited outcomes render their copy at 200 here; the JSON
// route (POST /api/newsletter/confirm) answers the exact 410 / 429 codes.

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
  if (!isWellFormedConfirmToken(token)) notFound();

  const site = await getCurrentSite();
  const h = await headers();
  const request = new Request('http://blog0.local/newsletter/confirm', { headers: h });
  const ip = clientIpFromRequest(request);
  const limited = await checkLink({ ip, siteId: site.id });
  if (limited.limited) {
    log.info('newsletter.link', { kind: 'confirm', outcome: 'rate_limited' });
    return <LinkPage brand={site.wordmark} heading={LINK_COPY.rateLimited.heading} body={LINK_COPY.rateLimited.body(limited.retryMinutes)} />;
  }

  let outcome: 'ok' | 'expired';
  try {
    const result = await confirmByToken(token, { ip, userAgent: h.get('user-agent') }, site);
    log.info('newsletter.link', { kind: 'confirm', outcome: 'ok', subscriber_id: result.subscriber.id });
    outcome = 'ok';
  } catch (err) {
    if (err instanceof ApiError && err.code === 'TOKEN_EXPIRED') {
      log.info('newsletter.link', { kind: 'confirm', outcome: 'expired' });
      outcome = 'expired';
    } else if (err instanceof ApiError && err.code === 'TOKEN_INVALID') {
      log.info('newsletter.link', { kind: 'confirm', outcome: 'invalid' });
      notFound();
    } else {
      throw err;
    }
  }
  if (outcome === 'expired') {
    return <LinkPage brand={site.wordmark} heading={LINK_COPY.expired.heading} body={LINK_COPY.expired.body()} />;
  }
  return <LinkPage brand={site.wordmark} heading={LINK_COPY.confirmed.heading} body={LINK_COPY.confirmed.body(site.brandName)} />;
}
