'use client';

import { useLayoutEffect, useMemo, useRef } from 'react';

import { useHeadTop, usePageLock } from '@/components/design/overlay';
import { ListenView } from '@/components/reader/ListenView';
import { ModeBar } from '@/components/reader/ModeBar';
import { ModeCapsule } from '@/components/reader/ModeCapsule';
import type { PublicListenDto } from '@/lib/api/dto';
import type { ListenViewModel } from '@/lib/view-models';

/* ============================================================
   Listen from a card (design SummaryOverlay, listen mode): a full sheet
   under the site header with the strip ("Listen | title", X), the SAME
   Listen view as the article page — tag, title, player and the article
   text, typed in and scrolling slowly with the audio (owner, after SMA-36:
   Listen looks the same wherever it is opened, like the deck) — and the
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

  /* one model per payload: ListenView re-binds its sync when this changes */
  const model = useMemo<ListenViewModel>(
    () => ({
      audioUrl: listen.audio.url,
      mimeType: listen.audio.mimeType,
      durationMs: listen.audio.durationMs,
      marks: listen.marks,
      timing: listen.timing,
      shareUrl: listen.shareUrl,
    }),
    [listen],
  );

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
        <ListenView
          key={listen.slug + '-listen'}
          topic={listen.topic}
          title={listen.title}
          bylineName={listen.bylineName}
          blocks={listen.blocks}
          listen={model}
          onClose={() => onCloseRef.current()}
        />
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
