import { StubNotice } from '@/components/StubNotice';

/* Listen before Phase 3 (divergence 9): the design's listen frame — tag and
   title — with a labelled stub where the player will go. */
export interface ListenStubProps {
  topic: string;
  title: string;
}

export function ListenStub({ topic, title }: ListenStubProps) {
  return (
    <section className="listenview" aria-label="Listen to this article">
      {topic ? <span className="tag">{topic}</span> : null}
      <h1>{title}</h1>
      <StubNotice>
        Listen arrives in Phase 3: the author&rsquo;s word-for-word reading, with the text highlighted in sync as it
        plays.
      </StubNotice>
    </section>
  );
}
