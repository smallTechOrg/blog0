'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Icon } from '@/components/design/Icon';
import { cx } from '@/components/design/motion';
import type { PostCardViewModel } from '@/lib/view-models';

import { archiveHref, archiveSummary, archiveTopics, filterArchive, groupByMonth, rowDate } from './archive-model';

/* ============================================================
   Archive (design `Archive`): header line, topic pills (a real filter —
   the chosen one reads as pressed), month groups of date + title rows with
   the quick TLDR button. The topic lives in `?topic=` so a footer topic
   lands here pre-filtered and the address can be shared. Listen stays
   hidden until an article has published audio (divergence 9).
   ============================================================ */
export interface ArchiveListProps {
  posts: PostCardViewModel[];
  /** From `?topic=` (already sanitised), or null for all topics. */
  topic: string | null;
}

export function ArchiveList({ posts, topic: initialTopic }: ArchiveListProps) {
  const router = useRouter();
  // The pill applies at once; back/forward or a footer topic link re-renders the page with a
  // new `?topic=`, which then wins (state adjusted during render, not in an effect).
  const [picked, setPicked] = useState<{ topic: string | null; from: string | null }>({ topic: initialTopic, from: initialTopic });
  if (picked.from !== initialTopic) setPicked({ topic: initialTopic, from: initialTopic });
  const topic = picked.from === initialTopic ? picked.topic : initialTopic;

  const topics = archiveTopics(posts);
  const shown = filterArchive(posts, topic);
  const groups = groupByMonth(shown);

  function choose(next: string | null): void {
    setPicked({ topic: next, from: initialTopic });
    router.replace(archiveHref(next), { scroll: false });
  }

  return (
    <main className="col">
      <header className="pagehead">
        <h1>Archive</h1>
        <p aria-live="polite">{archiveSummary(shown.length, topic)}</p>
      </header>
      {topics.length ? (
        <div className="archfilter" role="group" aria-label="Filter by topic">
          {[{ label: 'All topics', v: null as string | null }, ...topics.map((t) => ({ label: t, v: t as string | null }))].map((o) => {
            const on = topic === o.v;
            return (
              <button key={o.label} type="button" className={cx('topicpill', on && 'is-on')} aria-pressed={on} onClick={() => choose(o.v)}>
                {o.label}
              </button>
            );
          })}
        </div>
      ) : null}
      {!shown.length ? (
        <p className="archive-none">{posts.length ? 'Nothing filed under that topic yet.' : 'Nothing published yet.'}</p>
      ) : null}
      {groups.map((g) => (
        <section key={g.key}>
          <h2 className="archive-month">{g.heading}</h2>
          {g.items.map((it) => (
            <div key={it.slug} className="archive-row">
              <Link className="archive-row__link" href={'/p/' + it.slug}>
                <span className="meta">{rowDate(it.publishedLabel)}</span>
                <span className="t">{it.title}</span>
              </Link>
              {it.times.tldr != null ? (
                <div className="quick quick--row">
                  <Link
                    className="quick__btn"
                    href={'/p/' + it.slug + '/tldr'}
                    aria-label={'Summary of ' + it.title + ' — ' + it.times.tldr + ' min'}
                  >
                    <Icon name="bolt" size={14} />
                    <span>TLDR</span>
                    <span className="quick__d">{it.times.tldr + ' min'}</span>
                  </Link>
                </div>
              ) : null}
            </div>
          ))}
        </section>
      ))}
    </main>
  );
}
