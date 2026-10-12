import 'server-only';

import { and, eq } from 'drizzle-orm';

import { listenDiff } from '@/lib/listen/marks';

import { articleFormat } from '../db/schema';
import { readListenPayload, type ListenPayload } from './payload';
import type { FormatAdapter, PublishCheck } from './types';

// Listen adapter (spec/architecture.md §5; spec/capabilities/listen-sync.md → Publishing).
// Status: missing (no draft) → needs_sync (audio, no marks) → ready (syncFingerprint == the
// current revision's paragraphs fingerprint) → stale (paragraph set changed). No generating /
// failed (no background work). Nothing is ever re-synced automatically; the published copy keeps
// serving until a successful publish replaces (or clears) it.

export const LISTEN_STALE = 'LISTEN_STALE';

function sameMarks(a: readonly ListenPayload['marks'][number][], b: readonly ListenPayload['marks'][number][]): boolean {
  return a.length === b.length && a.every((m, i) => m.pid === b[i].pid && m.tMs === b[i].tMs);
}

function samePayload(a: ListenPayload | null, b: ListenPayload | null): boolean {
  if (!a || !b) return !a && !b;
  return a.audio.key === b.audio.key && sameMarks(a.marks, b.marks);
}

function staleCheck(marks: ListenPayload['marks'], pids: readonly string[], message: string): PublishCheck {
  const { missingPids, orphanPids } = listenDiff(marks, pids);
  return { ok: false, code: LISTEN_STALE, message, details: { missingPids, orphanPids } };
}

export const listenAdapter: FormatAdapter = {
  kind: 'listen',

  computeStatus({ row, currentRevision }) {
    const draft = readListenPayload(row?.draftPayload);
    if (!draft) return 'missing';
    if (draft.marks.length === 0) return 'needs_sync';
    return draft.syncFingerprint === currentRevision.paragraphsFingerprint ? 'ready' : 'stale';
  },

  isPublished: ({ article, row }) => article.status === 'published' && readListenPayload(row?.publishedPayload) !== null,

  hasUnpublishedChanges({ article, row }) {
    if (article.status !== 'published') return false;
    return !samePayload(readListenPayload(row?.draftPayload), readListenPayload(row?.publishedPayload));
  },

  validateForPublish({ row, revision, rendered }) {
    const draft = readListenPayload(row?.draftPayload);
    if (!draft) return { ok: true }; // no draft → the publish clears the published Listen
    const pids = rendered.paragraphs.map((p) => p.pid);

    if (draft.marks.length > 0) {
      if (draft.syncFingerprint === revision.paragraphsFingerprint) return { ok: true };
      return staleCheck(
        draft.marks,
        pids,
        'The text changed since the recording was synced — re-sync the changed paragraphs in the Listen tab (or remove the audio) before publishing.',
      );
    }

    // Audio uploaded but never synced: allowed when there is nothing live or the live Listen still
    // matches the text being published (Listen is simply not updated); otherwise the live reading
    // would desynchronise and the draft cannot replace it.
    const published = readListenPayload(row?.publishedPayload);
    if (!published || published.syncFingerprint === revision.paragraphsFingerprint) return { ok: true };
    return staleCheck(
      published.marks,
      pids,
      'The live reading no longer matches the text — sync the recording or remove the audio before publishing.',
    );
  },

  async publish(tx, { row, revision, now }) {
    if (!row) return;
    const draft = readListenPayload(row.draftPayload);
    const ready = draft !== null && draft.marks.length > 0 && draft.syncFingerprint === revision.paragraphsFingerprint;
    if (draft && !ready) return; // needs_sync (guard already proved the live copy still matches): leave the published copy
    await tx
      .update(articleFormat)
      .set(
        ready
          ? { publishedPayload: draft, publishedRevisionId: revision.id, publishedFingerprint: draft.syncFingerprint, publishedAt: now }
          : { publishedPayload: null, publishedRevisionId: null, publishedFingerprint: null, publishedAt: null },
      )
      .where(and(eq(articleFormat.id, row.id), eq(articleFormat.siteId, row.siteId)));
  },
};
