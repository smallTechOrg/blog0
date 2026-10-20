import { AboutBody } from './AboutBody';

/* ============================================================
   /about (design `About`): "About <wordmark>", the standfirst, the strap,
   then the body. Also the live preview on Admin → Site, so the writer sees
   exactly what the page will show.
   ============================================================ */
export interface AboutViewProps {
  wordmark: string;
  stand: string;
  strap: string;
  paragraphs: string[];
  /** `main` on the site; a plain `div` inside the admin preview. */
  as?: 'main' | 'div';
}

export function AboutView({ wordmark, stand, strap, paragraphs, as = 'main' }: AboutViewProps) {
  const Tag = as;
  return (
    <Tag className="col">
      <header className="pagehead">
        <h1>{'About ' + wordmark}</h1>
        <p>{stand}</p>
        <p className="abt__strap">{strap}</p>
      </header>
      <AboutBody paragraphs={paragraphs} />
    </Tag>
  );
}
