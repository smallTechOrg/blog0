import { LINK_COPY, LinkPage } from '@/components/site/newsletter/LinkPage';
import { getCurrentSite } from '@/server/site/current';

// 404 for a malformed or tampered unsubscribe token (TOKEN_INVALID), with the link-page copy.

export default async function UnsubscribeNotFound() {
  const site = await getCurrentSite();
  return <LinkPage brand={site.wordmark} heading={LINK_COPY.invalid.heading} body={LINK_COPY.invalid.body()} />;
}
