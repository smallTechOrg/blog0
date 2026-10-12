'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';

import { buildDeckSlides } from '@/lib/deck/timing';
import { articleSubject } from '@/lib/share-links';
import type { ArticleViewModel } from '@/lib/view-models';

import { ArticleBody } from './ArticleBody';
import { ArticleFoot } from './ArticleFoot';
import { ListenStub } from './ListenStub';
import { ModeBar } from './ModeBar';
import { ModeCapsule, type ReaderMode } from './ModeCapsule';
import { ParagraphShare } from './ParagraphShare';
import { ReadHead } from './ReadHead';
import { FALLBACK_BRAND, placeAgainst, useShare } from './ShareMenu';
import { TldrDeck } from './TldrDeck';

/* Article template — one component, every article (design ArticlePage):
   modebar strip, readhead, readbody, artfoot, and the capsule docked at the
   base of the viewport. TLDR opens the deck over the article; the tab
   underneath stays on Read, so closing the deck puts the reader back
   exactly where they were. */
export interface ArticleViewProps {
  article: ArticleViewModel;
  /** `'tldr'` when the page was loaded at /p/<slug>/tldr (ignored without a published deck). */
  initialMode?: 'read' | 'tldr';
  /** The site record's wordmark — the brand in every outgoing share text (spec/capabilities/paragraph-share.md). */
  brand?: string;
}

export function ArticleView({ article: a, initialMode = 'read', brand = FALLBACK_BRAND }: ArticleViewProps) {
  const router = useRouter();
  const [mode, setMode] = useState<'read' | 'listen'>('read');
  /* the deck is part of the address: /p/<slug>/tldr opens it, closing returns to /p/<slug> */
  const [deck, setDeck] = useState(initialMode === 'tldr' && a.deck != null);

  const base = '/p/' + a.slug;
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      // A /tldr load without a published deck falls back to Read at the plain address.
      if (deck || !window.location.pathname.endsWith('/tldr')) return;
    }
    try {
      const want = deck ? base + '/tldr' : base;
      if (window.location.pathname !== want) {
        window.history.replaceState(window.history.state, '', want + window.location.search);
      }
    } catch {
      /* history unavailable (sandboxed frames) — the deck still works */
    }
  }, [deck, base]);

  /* one share surface for the page: paragraphs, selections and Share article */
  const sharing = useShare(brand);
  const readRef = useRef<HTMLDivElement>(null);

  const slides = useMemo(
    () => (a.deck ? buildDeckSlides(a.title, a.dek, a.deck.slides.map((s) => s.text)) : []),
    [a.deck, a.title, a.dek],
  );

  function pickMode(k: ReaderMode) {
    if (k === 'tldr') {
      if (a.deck) setDeck(true);
      return;
    }
    setMode(k);
  }

  const listening = mode === 'listen';

  return (
    <main className="modeframe">
      <div className="artwrap">
        <ModeBar
          mode={listening ? 'listen' : 'read'}
          title={a.title}
          onClose={() => {
            if (listening) setMode('read');
            else router.push('/');
          }}
        />

        {/* Listen: the title and the player, nothing else on screen. Read comes
            back with the capsule or the X. */}
        {listening ? <ListenStub topic={a.topic} title={a.title} /> : null}

        {/* Read: tag and author/date across the top, then title, dek, body */}
        {!listening ? (
          <ReadHead
            key={a.slug}
            title={a.title}
            dek={a.dek}
            topic={a.topic}
            bylineName={a.bylineName}
            dateLabel={a.publishedLabel}
            inProgress={a.inProgress}
          />
        ) : null}

        {/* TL;DR is not an in-page section — it takes over the viewport */}
        {deck && a.deck && a.times.tldr != null ? (
          <TldrDeck
            key={a.slug + '-deck'}
            slides={slides}
            title={a.title}
            tag={a.topic}
            meta={a.publishedLabel + ' · ' + a.times.read + ' min read'}
            disclosure={a.deck.disclosure}
            shareLink={a.deck.shareUrl}
            brand={brand}
            times={{ read: a.times.read, tldr: a.times.tldr, listen: a.times.listen }}
            onClose={() => setDeck(false)}
            onRead={() => {
              setDeck(false);
              setMode('read');
            }}
            onListen={() => {
              setDeck(false);
              setMode('listen');
            }}
          />
        ) : null}

        {!listening ? (
          <div className="readbody" ref={readRef}>
            <ArticleBody blocks={a.blocks} />
            <ArticleFoot
              inProgress={a.inProgress}
              next={a.next}
              shareOpen={sharing.openKind === 'article'}
              onShare={(button, keyboard) =>
                sharing.share(articleSubject(a.title, a.articleUrl, brand), {
                  place: () => placeAgainst(button),
                  returnFocus: keyboard ? button : null,
                })
              }
            />
          </div>
        ) : null}
        {/* Read view only: tap/click/select a paragraph to share it; #p-… deep links */}
        {!listening ? (
          <ParagraphShare
            key={a.slug + '-share'}
            scopeRef={readRef}
            articleUrl={a.articleUrl}
            brand={brand}
            controller={sharing}
          />
        ) : null}
        {sharing.menu}
      </div>
      {/* The capsule floats at the base of the viewport in every mode. The deck
          carries its own copy, so this one steps aside while the deck is open. */}
      {deck ? null : (
        <div className="modedock">
          <ModeCapsule active={listening ? 'listen' : 'read'} times={a.times} onPick={pickMode} />
        </div>
      )}
    </main>
  );
}
