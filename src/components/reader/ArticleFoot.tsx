import Link from 'next/link';

/* The article's foot (design `.artfoot`): the in-progress note when flagged, then
   "Next: <title> →". Phase 2 adds the "Share article" button above it (S2.4). */
export interface ArticleFootProps {
  inProgress: boolean;
  next: { slug: string; title: string } | null;
}

export function ArticleFoot({ inProgress, next }: ArticleFootProps) {
  return (
    <div className="artfoot">
      {inProgress ? (
        <p>This piece is still being written. It is published here in draft so the team can read along.</p>
      ) : null}
      {next ? (
        <p style={{ margin: 0 }}>
          <Link href={'/p/' + next.slug}>{'Next: ' + next.title + ' →'}</Link>
        </p>
      ) : null}
    </div>
  );
}
