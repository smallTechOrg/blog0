import 'server-only';

import { listenBaseline, readListenPayload, type ListenPayload } from './payload';
import { publishDraft, type FormatAdapter } from './types';

// Listen adapter (spec/architecture.md §5; spec/capabilities/listen-audio.md). Status: missing (no
// draft) → ready (audio uploaded) → text_changed (the current paragraphs fingerprint differs from
// the draft's baseline = uploadFingerprint ?? syncFingerprint).
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

  /** Listen never blocks publishing. */
  validateForPublish: () => ({ ok: true }),

  publish(tx, { row, revision, now }) {
    const draft = readListenPayload(row?.draftPayload);
    return publishDraft(tx, row, draft, { revisionId: revision.id, fingerprint: draft && listenBaseline(draft), now });
  },
};
