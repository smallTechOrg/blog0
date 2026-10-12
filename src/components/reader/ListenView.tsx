'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

import { prefersReducedMotion } from '@/components/design/motion';
import type { Block } from '@/lib/content/types';
import { shareClickIgnored } from '@/lib/share-surface';
import type { ListenViewModel } from '@/lib/view-models';

import { ArticleBody } from './ArticleBody';
import { AudioPlayer, type AudioPlayerHandle } from './AudioPlayer';
import { createListenSync, isFormControl, isManualScrollKey, playerKeyAction, seekTarget, type ListenSync } from './listen-sync';

/* ============================================================
   Listen (spec/ui.md §3 Listen; divergences 28–29): the design's listen
   frame — tag, title, player — with the article text beside it. The player
   is primary; the text follows it on the server-resolved (estimated or
   stored) marks: the paragraph being read carries a soft .is-live and, while
   following, scrolls to centre. A manual scroll pauses following and shows
   **Follow audio** in the sticky lead; clicking it scrolls back to the live
   paragraph, resumes following and hands focus to ▶. A paragraph click seeks
   the audio to its start and resumes following; Space / ← / → drive the
   player from the window. The highlight is toggled straight on the DOM (the
   prose is memoised html), exactly like the share highlight.
   ============================================================ */
export interface ListenViewProps {
  topic: string;
  title: string;
  bylineName: string;
  blocks: ReadonlyArray<Block>;
  listen: ListenViewModel;
  /** Escape / the X: back to Read. */
  onClose: () => void;
}

const LIVE = 'is-live';

export function ListenView({ topic, title, bylineName, blocks, listen, onClose }: ListenViewProps) {
  const player = useRef<AudioPlayerHandle>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const syncRef = useRef<ListenSync | null>(null);
  const [following, setFollowing] = useState(true);
  const textId = useId();
  const live = useRef({ onClose });
  useLayoutEffect(() => {
    live.current = { onClose };
  });

  /* highlight + auto-scroll, bound to the player's <audio> */
  useEffect(() => {
    const scope = textRef.current;
    const audio = player.current?.audio();
    if (!scope || !audio) return;

    function paragraph(pid: string): HTMLElement | null {
      return scope!.querySelector<HTMLElement>('.para[data-pid="' + CSS.escape(pid) + '"]');
    }

    function scrollToPara(pid: string) {
      const el = paragraph(pid);
      if (!el) return;
      try {
        el.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      } catch {
        el.scrollIntoView();
      }
    }

    const sync = createListenSync(listen.marks, {
      onLive(pid) {
        scope.querySelectorAll('.para.' + LIVE).forEach((el) => el.classList.remove(LIVE));
        if (pid) paragraph(pid)?.classList.add(LIVE);
      },
      onScroll: scrollToPara,
      onFollowChange: setFollowing,
    });
    syncRef.current = sync;
    const unbind = sync.bind(audio);

    /* paragraphs are reachable from the keyboard: Enter / Space seeks */
    const focusable = Array.from(scope.querySelectorAll<HTMLElement>('.para[data-pid]'));
    focusable.forEach((el) => {
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    });

    /* a paragraph click / Enter / Space: seek to its start (play state unchanged), follow again */
    function seekTo(pid: string): boolean {
      const tMs = sync.paragraphClicked(pid);
      if (tMs === null) return false;
      player.current?.seek(tMs / 1000);
      return true;
    }
    function pidOf(target: EventTarget | null): string | null {
      if (!(target instanceof Element)) return null;
      const path: string[] = [];
      let node: Element | null = target;
      while (node && node !== scope) {
        path.push(node.tagName.toLowerCase());
        node = node.parentElement;
      }
      if (shareClickIgnored(path) || path.includes('figure')) return null;
      const para = target.closest<HTMLElement>('.para[data-pid]');
      return para && scope!.contains(para) ? para.dataset.pid || null : null;
    }

    const onClick = (e: MouseEvent) => {
      const pid = pidOf(e.target);
      if (pid && seekTo(pid)) e.preventDefault();
    };

    /* manual scrolls pause following; programmatic ones (scrollIntoView) never fire these */
    const manual = () => sync.noteManualScroll();
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const active = document.activeElement as HTMLElement | null;
      if (isManualScrollKey(e.key, isFormControl(active))) {
        manual();
        return;
      }
      const focusedPara = active?.closest<HTMLElement>('.para[data-pid]');
      if (focusedPara && scope.contains(focusedPara) && (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar')) {
        if (seekTo(focusedPara.dataset.pid || '')) e.preventDefault();
        return;
      }
      const action = playerKeyAction(e.key, isFormControl(active));
      if (!action) return;
      if (action === 'close') {
        live.current.onClose();
        return;
      }
      e.preventDefault();
      if (action === 'toggle') player.current?.toggle();
      else player.current?.seek(seekTarget(action, player.current.currentTime(), listen.durationMs / 1000));
    };

    scope.addEventListener('click', onClick);
    window.addEventListener('wheel', manual, { passive: true });
    window.addEventListener('touchmove', manual, { passive: true });
    window.addEventListener('keydown', onKey);
    return () => {
      unbind();
      syncRef.current = null;
      setFollowing(true); // a fresh tracker starts out following
      scope.removeEventListener('click', onClick);
      window.removeEventListener('wheel', manual);
      window.removeEventListener('touchmove', manual);
      window.removeEventListener('keydown', onKey);
      scope.querySelectorAll('.para.' + LIVE).forEach((el) => el.classList.remove(LIVE));
    };
  }, [listen]);

  return (
    <section className="listenview listenview--synced" aria-label="Listen to this article">
      <div className="listenview__lead">
        {topic ? <span className="tag">{topic}</span> : null}
        <h1>{title}</h1>
        <AudioPlayer
          ref={player}
          audio={{ url: listen.audioUrl, mimeType: listen.mimeType, durationMs: listen.durationMs }}
          bylineName={bylineName}
        />
        <button
          type="button"
          className="btn-outline listenview__follow"
          aria-controls={textId}
          hidden={following}
          onClick={() => {
            syncRef.current?.followAudio();
            player.current?.focusPlay();
          }}
        >
          Follow audio
        </button>
      </div>
      <div className="listenview__text" id={textId}>
        <div className="readbody" ref={textRef}>
          <ArticleBody blocks={blocks} />
        </div>
      </div>
    </section>
  );
}
