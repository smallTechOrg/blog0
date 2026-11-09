import Link from 'next/link';

import { ShareLinkButton } from './ShareLinkButton';

/* The article's foot (design `.artfoot`): the Share article button (divergence 5), the
   in-progress note when flagged, then "Next: <title> →". */
export interface ArticleFootProps {
  inProgress: boolean;
  next: { slug: string; title: string } | null;
  /** Share article: the host copies the article text + link and opens the menu against the button. */
  onShare?: (button: HTMLButtonElement, keyboard: boolean) => void;
  shareOpen?: boolean;
}

export function ArticleFoot({ inProgress, next, onShare, shareOpen }: ArticleFootProps) {
  return (
    <div className="artfoot">
      {onShare ? (
        <p style={{ margin: '0 0 16px' }}>
          <ShareLinkButton onShare={onShare} label="Share article" expanded={shareOpen} />
        </p>
      ) : null}
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
