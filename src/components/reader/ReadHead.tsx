'use client';

import { Dek } from '@/components/design/Dek';
import { dekDelay } from '@/components/design/motion';
import { SplitHeadline } from '@/components/design/SplitHeadline';

/* Read: tag and author/date across the top, then title, dek, rule
   (design ArticlePage `.readhead`). Shared by the public article page and the
   editor's live preview, so preview == published. */
export interface ReadHeadProps {
  title: string;
  dek: string;
  topic: string;
  bylineName: string;
  /** Already formatted, e.g. "8 Sep 2026" (`fmtDate`). The preview passes its own label. */
  dateLabel: string;
  /** Shows the "Draft — in progress" badge. */
  inProgress?: boolean;
}

export function ReadHead({ title, dek, topic, bylineName, dateLabel, inProgress }: ReadHeadProps) {
  return (
    <header className="readhead">
      <div className="readhead__top">
        <div className="arthead__tags" style={{ margin: 0 }}>
          {topic ? <span className="tag">{topic}</span> : null}
          {inProgress ? <span className="tag tag--draft">Draft — in progress</span> : null}
        </div>
        <div className="readhead__by">
          <b>{bylineName}</b>
          <i aria-hidden="true" />
          <span>{dateLabel}</span>
        </div>
      </div>
      <SplitHeadline text={title} />
      {dek ? (
        <Dek className="dek" delay={dekDelay(title)}>
          {dek}
        </Dek>
      ) : null}
      <div className="readhead__rule" aria-hidden="true" />
    </header>
  );
}
