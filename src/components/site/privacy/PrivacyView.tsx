import { AboutBody } from '../about/AboutBody';

/* /privacy (fix pass): "Privacy" h1, the site's privacy text as paragraphs (text only, no HTML),
   the fixed analytics note, and the erasure contact line. Also the live preview on Admin → Site. */
/** Fixed last paragraph: the public pages load smallTech's shared Google Analytics script (public/st-analytics.js). */
export const PRIVACY_ANALYTICS_NOTE =
  'Analytics. The public pages of this site use Google Analytics, operated by smallTech, to count page views and clicks. It sets cookies in your browser. We do not send your name or email address to it.';

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
      <AboutBody paragraphs={[...paragraphs, PRIVACY_ANALYTICS_NOTE]} />
      <p className="priv-contact">
        Questions or an erasure request: <a href={'mailto:' + contactEmail}>{contactEmail}</a>
      </p>
    </Tag>
  );
}
