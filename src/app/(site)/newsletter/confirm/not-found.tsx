import { LINK_COPY, LinkPage } from '@/components/site/newsletter/LinkPage';
import { getCurrentSite } from '@/server/site/current';

// 404 for an unknown or malformed confirm token (TOKEN_INVALID) — rendered by notFound() from the
// page, with a real 404 status and the link-page copy (spec/ui.md §3).

export default async function ConfirmNotFound() {
  const site = await getCurrentSite();
  return <LinkPage brand={site.wordmark} heading={LINK_COPY.invalid.heading} body={LINK_COPY.invalid.body()} />;
}
