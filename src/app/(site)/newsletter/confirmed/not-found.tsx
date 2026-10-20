import { LINK_COPY, LinkPage } from '@/components/site/newsletter/LinkPage';
import { getCurrentSite } from '@/server/site/current';

// 404 for a malformed or unknown confirm token (the confirm link 303s to ?status=invalid) — a real 404
// status with the link-page copy (spec/ui.md §3).

export default async function ConfirmedNotFound() {
  const site = await getCurrentSite();
  return <LinkPage brand={site.wordmark} heading={LINK_COPY.invalid.heading} body={LINK_COPY.invalid.body()} />;
}
