'use client';

import { useRouter } from 'next/navigation';
import { useRef } from 'react';

import { Icon } from '@/components/design/Icon';
import type { SiteViewModel } from '@/lib/view-models';

import { useAsciiHand, useEof } from './AsciiHand';
import { NewsletterForm } from './NewsletterForm';

/* ============================================================
   Footer — one block: newsletter first, then contact, social, sitemap
   (design Footer). Brand values come from the site record (div. 25);
   X / LinkedIn only when the site has their URLs, no RSS (div. 12).
   ============================================================ */
export interface FooterProps {
  site: SiteViewModel;
}

export function Footer({ site }: FooterProps) {
  const router = useRouter();
  const footRef = useRef<HTMLElement>(null);
  const cvRef = useRef<HTMLCanvasElement>(null);
  const eofRef = useRef<HTMLSpanElement>(null);
  useAsciiHand(footRef, cvRef);
  useEof(footRef, eofRef, site.wordmark);
  const head = site.wordmark.slice(0, -1);
  const tail = site.wordmark.slice(-1);

  return (
    <footer className="site-footer" ref={footRef}>
      <canvas className="ft-ascii" ref={cvRef} aria-hidden="true" />
      <div className="ft-in ft-grid">
        <NewsletterForm />
        <section className="ft-right">
          <div className="ft-logo" aria-label={site.wordmark}>
            {head}
            <span className="ft-zero" aria-hidden="true">
              {tail}
            </span>
          </div>
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
          <hr className="ft-dot" />
          <p className="ft-pitch">Tips, corrections, or a pitch:</p>
          <a className="ft-mail" href={'mailto:' + site.contactEmail}>
            {site.contactEmail}
          </a>
          <ul className="ft-icons">
            {site.socialXUrl ? (
              <li>
                <a href={site.socialXUrl} aria-label={site.wordmark + ' on X'} target="_blank" rel="noopener noreferrer">
                  <Icon name="x" size={20} />
                </a>
              </li>
            ) : null}
            {site.socialLinkedinUrl ? (
              <li>
                <a
                  href={site.socialLinkedinUrl}
                  aria-label={site.wordmark + ' on LinkedIn'}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Icon name="linkedin" size={20} />
                </a>
              </li>
            ) : null}
            <li>
              <a href={'mailto:' + site.contactEmail} aria-label={'Email ' + site.wordmark}>
                <Icon name="mail" size={20} />
              </a>
            </li>
          </ul>
        </section>
      </div>
      <div className="ft-bar">
        <p className="ft-copy">
          <span>
            {'© ' + site.year + ' '}
            <b>{' ' + site.wordmark}</b>
          </span>
          <i aria-hidden="true" />
          <span>
            <span className="brandmark__logo" aria-hidden="true" />
            {site.publisherName}
          </span>
        </p>
        <p className="ft-eof" aria-hidden="true">
          <span ref={eofRef} />
          <span className="ft-us">_</span>
        </p>
      </div>
    </footer>
  );
}
