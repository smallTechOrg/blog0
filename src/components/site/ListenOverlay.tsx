'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { Icon } from '@/components/design/Icon';
import { cx } from '@/components/design/motion';
import { AudioPlayer } from '@/components/reader/AudioPlayer';
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

  /* Locking the page can clamp its scroll, so the offset is recorded on open
     and put back on close — the reader lands exactly where they left off. */
  useEffect(() => {
    const at = window.pageYOffset || document.documentElement.scrollTop || 0;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
      window.requestAnimationFrame(() => {
        const now = window.pageYOffset || document.documentElement.scrollTop || 0;
        if (Math.abs(now - at) > 2) window.scrollTo({ top: at, behavior: 'auto' });
      });
    };
  }, []);

  /* Sits under the site header, like the deck, so the frame reads the same
     whether Listen was opened from a card or from inside the article. */
  const [headTop, setHeadTop] = useState(0);
  useLayoutEffect(() => {
    function measure() {
      const el = document.querySelector('.sitehead');
      setHeadTop(el ? Math.max(0, Math.round(el.getBoundingClientRect().bottom)) : 0);
    }
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  const { times } = listen;
  const modes: Array<{ key: 'read' | 'tldr' | 'listen'; label: string; icon: 'text' | 'bolt' | 'headphones'; min: number | null; go: (() => void) | null }> = [
    { key: 'read', label: 'Read', icon: 'text', min: times.read, go: onRead },
    { key: 'tldr', label: 'TLDR', icon: 'bolt', min: times.tldr, go: onTldr && times.tldr != null ? onTldr : null },
    { key: 'listen', label: 'Listen', icon: 'headphones', min: times.listen, go: null },
  ];

  return (
    <div className="sheetfull" role="dialog" aria-modal="true" aria-label={listen.title} style={{ top: headTop + 'px' }}>
      <div className="sheetfull__scrim" />
      <div className="sheetfull__panel">
        <div className="modebar">
          <div className="modebar__crumb">
            <span className="modebar__mode">Listen</span>
            <span className="modebar__sep" aria-hidden="true" />
            <span className="modebar__title">{listen.title}</span>
          </div>
          <button className="modebar__x" type="button" onClick={onClose} aria-label="Close">
            <Icon name="close" size={14} />
          </button>
        </div>
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
          <div className="modes modes--timed" role="tablist" aria-label="How to take this in">
            {modes.map((m) => {
              const on = m.key === 'listen';
              const missing = m.min == null;
              return (
                <button
                  key={m.key}
                  type="button"
                  className={cx('mode', on && 'is-on')}
                  role="tab"
                  aria-selected={on ? 'true' : 'false'}
                  aria-label={missing ? m.label + ' — no summary yet' : m.label + ' — ' + m.min + ' min'}
                  disabled={!on && !m.go}
                  title={!on && missing ? 'No summary yet' : undefined}
                  onClick={() => m.go?.()}
                >
                  <Icon name={m.icon} size={14} />
                  <span className="mode__t">{m.label}</span>
                  <span className="mode__d">{m.min != null ? m.min + ' min' : '—'}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
