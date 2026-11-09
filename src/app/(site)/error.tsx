'use client';

// Error boundary for the public pages (spec/ui.md: every view has an error state). It renders
// inside the (site) layout, so the masthead and footer stay. Nothing about the error is shown or
// logged here — production server errors reach the client as a generic message plus a digest,
// and the server has already logged them (event `error`, with the same digest).

export default function SiteError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <main className="col">
      <header className="pagehead" role="alert">
        <h1>Something went wrong &mdash; reload</h1>
        <p>The page didn&rsquo;t load. Trying again usually fixes it.</p>
      </header>
      <div className="feed__cta">
        <button type="button" className="btn-outline" onClick={() => retry()}>
          Reload
        </button>
      </div>
    </main>
  );
}
