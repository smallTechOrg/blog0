import 'server-only';

import { and, eq } from 'drizzle-orm';

import { reconcileSlides } from '@/lib/deck/reconcile';

import type { Tx } from '../db/client';
import { articleFormat, type RevisionRow } from '../db/schema';
import { readTldrPayload, type TldrPayload } from '../formats/payload';
import { findFormatRow } from './repo';
import { renderRevision } from './views';

// SMA-52: when the article is saved as a new revision, the draft TLDR deck follows it. Each slide is
// re-attached to the sentence with the same text (its id may have changed, its position too), so an
// edit only ever affects the slides whose own text was edited. The deck is `ready` again (its
// fingerprint moves to the new revision) unless some slide's text is gone — then it stays `stale`
// until the writer removes or replaces those lines.

export async function rebaseDeckOnRevision(tx: Tx, siteId: string, articleId: string, revision: RevisionRow): Promise<void> {
  const row = await findFormatRow(siteId, articleId, 'tldr', tx);
  const draft = readTldrPayload(row?.draftPayload);
  if (!row || !draft) return;

  const rendered = await renderRevision(revision);
  const result = reconcileSlides(draft.slides, rendered.lines);
  const complete = result.missing.length === 0;
  if (!result.rebased && !complete) return; // nothing changed and it was (and stays) stale

  const payload: TldrPayload = result.rebased ? { ...draft, slides: result.slides } : draft;
  await tx
    .update(articleFormat)
    .set({
      draftPayload: payload,
      ...(complete ? { draftRevisionId: revision.id, draftFingerprint: revision.sentencesFingerprint } : {}),
    })
    .where(and(eq(articleFormat.id, row.id), eq(articleFormat.siteId, siteId)));
}
