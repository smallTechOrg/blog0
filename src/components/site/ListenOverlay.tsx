'use client';

import { useLayoutEffect, useRef } from 'react';

import { useHeadTop, usePageLock } from '@/components/design/overlay';
import { AudioPlayer } from '@/components/reader/AudioPlayer';
import { ModeBar } from '@/components/reader/ModeBar';
import { ModeCapsule } from '@/components/reader/ModeCapsule';
import type { PublicListenDto } from '@/lib/api/dto';

/* ============================================================
   Listen from a card (design SummaryOverlay, listen mode): a full sheet
   under the site header with the strip ("Listen | title", X), the tag, the
   title and the player — compact, no text column (divergence 28) — and the
   three-way capsule at the base: Read opens the article, TLDR hands over to
   the deck, Listen is where we are. Escape / X close; the page's scroll
   offset is put back on close.
   ============================================================ */
export interface ListenOverlayProps {
  listen: PublicListenDto;
  onClose: () => void;
  /** Read in the capsule → the article page. */
  onRead: () => void;
  /** TLDR in the capsule → the deck for the same post (absent without a published deck). */
  onTldr?: () => void;
}

export function ListenOverlay({ listen, onClose, onRead, onTldr }: ListenOverlayProps) {
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });

  /* The page underneath is locked; its scroll offset is put back on close. */
  usePageLock();
  /* Sits under the site header, like the deck, so the frame reads the same
     whether Listen was opened from a card or from inside the article. */
  const headTop = useHeadTop();

  return (
    <div className="sheetfull" role="dialog" aria-modal="true" aria-label={listen.title} style={{ top: headTop + 'px' }}>
      <div className="sheetfull__scrim" />
      <div className="sheetfull__panel">
        <ModeBar mode="listen" title={listen.title} onClose={onClose} closeLabel="Close" />
        <section className="listenview" aria-label="Listen to this article">
          {listen.topic ? <span className="tag">{listen.topic}</span> : null}
          <h1>{listen.title}</h1>
          <AudioPlayer
            key={listen.slug + '-a'}
            audio={listen.audio}
            bylineName={listen.bylineName}
            hotkeys
            onEscape={() => onCloseRef.current()}
          />
        </section>
        <div className="modedock">
          <ModeCapsule
            active="listen"
            times={listen.times}
            enabled={{ tldr: Boolean(onTldr) }}
            onPick={(mode) => {
              if (mode === 'read') onRead();
              else if (mode === 'tldr') onTldr?.();
            }}
          />
        </div>
      </div>
    </div>
  );
}
