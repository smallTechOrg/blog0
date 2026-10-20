import { AboutBody } from '../about/AboutBody';

/* /privacy (fix pass): "Privacy" h1, the site's privacy text as paragraphs (text only, no HTML),
   and the erasure contact line. Also the live preview on Admin → Site. */
export interface PrivacyViewProps {
  paragraphs: string[];
  contactEmail: string;
  /** `main` on the site; a plain `div` inside the admin preview. */
  as?: 'main' | 'div';
}

export function PrivacyView({ paragraphs, contactEmail, as = 'main' }: PrivacyViewProps) {
  const Tag = as;
  return (
    <Tag className="col">
      <header className="pagehead">
        <h1>Privacy</h1>
      </header>
      <AboutBody paragraphs={paragraphs} />
      <p className="priv-contact">
        Questions or an erasure request: <a href={'mailto:' + contactEmail}>{contactEmail}</a>
      </p>
    </Tag>
  );
}
