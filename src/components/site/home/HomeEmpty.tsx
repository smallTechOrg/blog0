import Link from 'next/link';

/* Nothing published yet (not in the design, which always has posts): the Latest
   head with a plain status line, plus a way into the desk for a signed-in admin. */
export function HomeEmpty({ signedIn }: { signedIn: boolean }) {
  return (
    <section className="home-sec" aria-labelledby="feed-h">
      <div className="sechead">
        <h2 id="feed-h">Latest</h2>
      </div>
      <div className="feed__cta">
        <p className="feed__status" aria-live="polite">
          Nothing published yet.
        </p>
        {signedIn ? (
          <Link className="btn-outline" href="/admin">
            Go to the desk
          </Link>
        ) : null}
      </div>
    </section>
  );
}
