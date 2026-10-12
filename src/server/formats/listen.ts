import 'server-only';

import { and, eq } from 'drizzle-orm';

import { articleFormat } from '../db/schema';
import { listenBaseline, readListenPayload, type ListenPayload } from './payload';
import type { FormatAdapter } from './types';

// Listen adapter (spec/architecture.md §5, revised by the Phase 3 fix; spec/capabilities/
// listen-audio.md). Status: missing (no draft) → ready (audio uploaded) → text_changed (the current
// paragraphs fingerprint differs from the draft's baseline = uploadFingerprint ?? syncFingerprint).
// text_changed is a warning only: Listen NEVER blocks publishing, and publishing copies the draft
// whatever its status (reader timing is resolved per request from the published text, so it can
// never go stale). Stored marks never affect the status. No generating / failed.

function sameMarks(a: readonly ListenPayload['marks'][number][], b: readonly ListenPayload['marks'][number][]): boolean {
  return a.length === b.length && a.every((m, i) => m.pid === b[i].pid && m.tMs === b[i].tMs);
}

function samePayload(a: ListenPayload | null, b: ListenPayload | null): boolean {
  if (!a || !b) return !a && !b;
  return a.audio.key === b.audio.key && sameMarks(a.marks, b.marks);
}

export const listenAdapter: FormatAdapter = {
  kind: 'listen',

  computeStatus({ row, currentRevision }) {
    const draft = readListenPayload(row?.draftPayload);
    if (!draft) return 'missing';
    const baseline = listenBaseline(draft);
    return baseline !== null && baseline !== currentRevision.paragraphsFingerprint ? 'text_changed' : 'ready';
  },

  isPublished: ({ article, row }) => article.status === 'published' && readListenPayload(row?.publishedPayload) !== null,

  hasUnpublishedChanges({ article, row }) {
    if (article.status !== 'published') return false;
    return !samePayload(readListenPayload(row?.draftPayload), readListenPayload(row?.publishedPayload));
  },

  /** Listen never blocks publishing (the Phase 3 stale-sync guard is gone). */
  validateForPublish() {
    return { ok: true };
  },

  async publish(tx, { row, revision, now }) {
    if (!row) return;
    const draft = readListenPayload(row.draftPayload);
    await tx
      .update(articleFormat)
      .set(
        draft
          ? { publishedPayload: draft, publishedRevisionId: revision.id, publishedFingerprint: listenBaseline(draft), publishedAt: now }
          : { publishedPayload: null, publishedRevisionId: null, publishedFingerprint: null, publishedAt: null },
      )
      .where(and(eq(articleFormat.id, row.id), eq(articleFormat.siteId, row.siteId)));
  },
};
