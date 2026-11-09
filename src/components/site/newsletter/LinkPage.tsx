import Link from 'next/link';

/* The newsletter link pages' one card (spec/ui.md §3 "Newsletter link pages"): eyebrow tag, a plain
   h1 and one paragraph, then Back to blog0. No typing animation. Used by the
   confirm result page (/newsletter/confirmed) and the 404s; role=status so the outcome is announced. */

export interface LinkPageProps {
  heading: string;
  body: string;
  brand: string;
}

export function LinkPage({ heading, body, brand }: LinkPageProps) {
  return (
    <main className="col">
      <section className="nl-page" aria-labelledby="nl-page-h">
        <span className="tag">Newsletter</span>
        <h1 id="nl-page-h">{heading}</h1>
        <p role="status">{body}</p>
        <Link className="btn-outline" href="/">
          Back to {brand}
        </Link>
      </section>
    </main>
  );
}

export const LINK_COPY = {
  confirmed: {
    heading: (brand: string) => `You’re confirmed — welcome to ${brand}.`,
    body: (brand: string) => `Thanks — ${brand} issues will land in this inbox. Unsubscribe any time from the link at the bottom of each one.`,
  },
  alreadyConfirmed: {
    heading: 'You’re already confirmed.',
    body: (brand: string) => `${brand} issues will keep landing in this inbox. Unsubscribe any time from the link at the bottom of each one.`,
  },
  expired: {
    heading: 'This link has expired or was already used.',
    body: () => 'Sign up again from the footer of any page and we’ll send a fresh link.',
  },
  invalid: {
    heading: 'That link isn’t valid.',
    body: () => 'Check the address you were sent, or sign up again from the footer.',
  },
  unsubscribed: {
    heading: 'You’re unsubscribed. Sorry to see you go.',
    body: () => 'You won’t get another issue. Changed your mind? Sign up again from the footer any time.',
  },
  rateLimited: {
    heading: 'Too many requests.',
    body: (minutes: number) => `Try the link again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
  },
  failed: {
    heading: 'Something went wrong.',
    body: () => 'Something went wrong — try the link again.',
  },
} as const;
