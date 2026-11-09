'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef } from 'react';

import { Icon } from '@/components/design/Icon';
import type { SiteViewModel } from '@/lib/view-models';

import { useAsciiHand } from './AsciiHand';
import { NewsletterForm } from './NewsletterForm';

/* ============================================================
   Footer — one block: newsletter first, then contact, social, sitemap
   (design Footer). Brand values come from the site record (div. 25);
   X / LinkedIn only when the site has their URLs, no RSS (div. 12). No
   "> end of <brand>" line (dropped with the boot strip, UI review 2026-10-20).
   ============================================================ */
/** The publisher's website, behind the footer's globe icon. */
const PUBLISHER_URL = 'https://smalltech.in';

export interface FooterProps {
  site: SiteViewModel;
}

export function Footer({ site }: FooterProps) {
  const router = useRouter();
  const footRef = useRef<HTMLElement>(null);
  const cvRef = useRef<HTMLCanvasElement>(null);
  useAsciiHand(footRef, cvRef);
  const head = site.wordmark.slice(0, -1);
  const tail = site.wordmark.slice(-1);

  return (
    <footer className="site-footer" ref={footRef}>
      <canvas className="ft-ascii" ref={cvRef} aria-hidden="true" />
      <div className="ft-in ft-grid">
        <NewsletterForm consentText={site.newsletterConsentText} />
        <section className="ft-right">
          <div className="ft-logo" aria-label={site.wordmark}>
            {head}
            <span className="ft-zero" aria-hidden="true">
              {tail}
            </span>
          </div>
          {/* Topics and contact side by side (owner review 2026-11-09): one compact row, not a stack. */}
          <div className="ft-cols">
            {/* the real topics, each opening the archive filtered to it */}
            {site.topics.length ? (
              <nav aria-label="Footer topics" id="topics">
                <ul className="ft-topics">
                  {site.topics.map((t) => (
                    <li key={t}>
                      <button type="button" onClick={() => router.push('/archive?topic=' + encodeURIComponent(t))}>
                        {t}
                      </button>
                    </li>
                  ))}
                </ul>
              </nav>
            ) : null}
            <div className="ft-contact">
              <p className="ft-pitch">Want to reach out?</p>
              <a className="ft-mail" href={'mailto:' + site.contactEmail}>
                {site.contactEmail}
              </a>
              <ul className="ft-icons">
                {site.socialLinkedinUrl ? (
                  <li>
                    <a
                      href={site.socialLinkedinUrl}
                      aria-label={site.publisherName + ' on LinkedIn'}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Icon name="linkedin" size={20} />
                    </a>
                  </li>
                ) : null}
                <li>
                  <a href={PUBLISHER_URL} aria-label={site.publisherName + ' website'} target="_blank" rel="noopener noreferrer">
                    <Icon name="globe" size={20} />
                  </a>
                </li>
                {site.socialXUrl ? (
                  <li>
                    <a href={site.socialXUrl} aria-label={site.wordmark + ' on X'} target="_blank" rel="noopener noreferrer">
                      <Icon name="x" size={20} />
                    </a>
                  </li>
                ) : null}
              </ul>
            </div>
          </div>
        </section>
      </div>
      <div className="ft-bar">
        <p className="ft-copy">
          {/* owner review 2026-11-09: no wordmark here, the footer already carries it */}
          <span>{'© ' + site.year}</span>
          <i aria-hidden="true" />
          <a href={PUBLISHER_URL} target="_blank" rel="noopener noreferrer">
            <span className="brandmark__logo" aria-hidden="true" />
            {site.publisherName}
          </a>
          <i aria-hidden="true" />
          <Link href="/privacy">Privacy</Link>
        </p>
      </div>
    </footer>
  );
}
