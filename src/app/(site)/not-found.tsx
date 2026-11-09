import Link from 'next/link';

// Unknown, malformed or unpublished article slugs (notFound() from the (site) routes) render
// here, inside the site chrome, with a 404 status (spec/capabilities/article-reading.md).

export default function SiteNotFound() {
  return (
    <main className="col">
      <header className="pagehead">
        <h1>That article isn&rsquo;t here.</h1>
        <p>It may have been unpublished, or the link is mistyped.</p>
      </header>
      <div className="feed__cta">
        <Link className="btn-outline" href="/">
          Back to all articles
        </Link>
      </div>
    </main>
  );
}
