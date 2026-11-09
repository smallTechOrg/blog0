import { connection } from 'next/server';

import SiteLayout from './(site)/layout';
import SiteNotFound from './(site)/not-found';

import { getCurrentSite } from '@/server/site/current';

// Root 404: any URL no route matches (e.g. /nope, /admin/nope) renders here, under the root layout
// only. Wrap it in the public site chrome (masthead + footer + print-in) by reusing the (site)
// layout and its not-found body, so an unknown URL never renders bare.

export default async function RootNotFound() {
  // The chrome reads the site record and topics from the DB: render per request, never at build.
  await connection();
  try {
    await getCurrentSite();
  } catch {
    // No DB or no site row: still answer with the 404 body rather than turning it into a 500.
    return (
      <div id="blog0-root">
        <SiteNotFound />
      </div>
    );
  }
  return (
    <SiteLayout>
      <SiteNotFound />
    </SiteLayout>
  );
}
