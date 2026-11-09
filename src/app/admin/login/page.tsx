import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { LoginForm } from '@/components/admin/LoginForm';
import { safeNextPath } from '@/server/auth/login';
import { SESSION_COOKIE_NAME, validateSessionToken } from '@/server/auth/session';
import { log } from '@/server/log';
import { getCurrentSite } from '@/server/site/current';

// /admin/login (spec/ui.md → Sign in). Centered `.surface` card; styles live in admin.css
// (`.admin-login*`, loaded via src/app/admin/layout.tsx). Already signed in → `next` or /admin.

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Sign in · desk',
  robots: { index: false, follow: false },
};

const FALLBACK_WORDMARK = 'blog0';

async function loadSiteAndUser(): Promise<{ wordmark: string; signedIn: boolean }> {
  try {
    const site = await getCurrentSite();
    const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value ?? null;
    const signedIn = token ? (await validateSessionToken(token, site.id)) !== null : false;
    return { wordmark: site.wordmark, signedIn };
  } catch (error) {
    // Keep the sign-in page renderable (e.g. before `pnpm db:seed`); the API reports the real error.
    log.error('error', { msg: 'Sign-in page could not load the site', err_message: error instanceof Error ? error.message : String(error) });
    return { wordmark: FALLBACK_WORDMARK, signedIn: false };
  }
}

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { next } = await searchParams;
  const nextPath = safeNextPath(next);
  const { wordmark, signedIn } = await loadSiteAndUser();
  if (signedIn) redirect(nextPath);

  const head = wordmark.slice(0, -1);
  const last = wordmark.slice(-1);

  return (
    <main className="admin-login">
      <section className="surface admin-login__card" aria-labelledby="admin-login-title">
        <p className="admin-login__brand">
          <span className="wordmark" aria-label={`${wordmark} desk`}>
            {head}
            <span className="wordmark__o">{last}</span>
          </span>
          <span className="admin-login__desk mono" aria-hidden="true">
            · desk
          </span>
        </p>
        <h1 id="admin-login-title" className="admin-login__title">
          Sign in to the desk
        </h1>
        <LoginForm next={nextPath} />
      </section>
    </main>
  );
}
