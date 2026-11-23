import 'server-only';

import { cookies } from 'next/headers';

import { getCurrentSite } from '../site/current';
import { SESSION_COOKIE_NAME, validateSessionToken } from './session';

// SMA-51: is the visitor of a PUBLIC page signed in to the desk? Every desk user is an author/admin of
// this site (there is one role), so a valid session is what shows the "Edit" button. Reading the cookie
// makes the page per-request (it already is: the nonce comes from the request headers) and the result
// never reaches the HTML of an anonymous reader.

export async function viewerIsSignedIn(): Promise<boolean> {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  if (!token) return false;
  const site = await getCurrentSite();
  return (await validateSessionToken(token, site.id)) !== null;
}
