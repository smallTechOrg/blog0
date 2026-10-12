import 'server-only';

import type { Sentence } from '@/lib/content/types';

import { readTldrPayload, type TldrSlide } from './payload';
import { isGenerationActive, publishDraft, type FormatAdapter } from './types';

// TLDR adapter (spec/architecture.md §5):
// generating (latest run `running` < 3 min) → ready (draft fp == current sentences fp) → stale
// (fp differs) → failed (no draft, latest run failed) → missing.

/** Slides whose sid + text no longer exist among the given eligible sentences. */
export function missingSlides(slides: readonly Pick<TldrSlide, 'sid' | 'text'>[], sentences: readonly Sentence[]): string[] {
  const textBySid = new Map(sentences.map((s) => [s.sid, s.text]));
  return slides.filter((s) => textBySid.get(s.sid) !== s.text).map((s) => s.sid);
}

function sameSlides(a: readonly TldrSlide[] | undefined, b: readonly TldrSlide[] | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.length === b.length && a.every((s, i) => s.sid === b[i].sid && s.text === b[i].text);
}

export const tldrAdapter: FormatAdapter = {
  kind: 'tldr',

  computeStatus({ row, currentRevision, latestGeneration, now }) {
    if (isGenerationActive(latestGeneration, now)) return 'generating';
    const draft = readTldrPayload(row?.draftPayload);
    if (draft) return row?.draftFingerprint === currentRevision.sentencesFingerprint ? 'ready' : 'stale';
    if (latestGeneration && latestGeneration.status !== 'succeeded') return 'failed';
    return 'missing';
  },

  isPublished: ({ article, row }) => article.status === 'published' && readTldrPayload(row?.publishedPayload) !== null,

  hasUnpublishedChanges({ article, row }) {
    if (article.status !== 'published') return false;
    return !sameSlides(readTldrPayload(row?.draftPayload)?.slides, readTldrPayload(row?.publishedPayload)?.slides);
  },

  validateForPublish({ row, rendered }) {
    const draft = readTldrPayload(row?.draftPayload);
    if (!draft) return { ok: true };
    const sids = missingSlides(draft.slides, rendered.sentences);
    if (sids.length === 0) return { ok: true };
    return {
      ok: false,
      code: 'TLDR_DECK_STALE',
      message: `${sids.length} TLDR line${sids.length === 1 ? ' is' : 's are'} no longer in the article — remove or replace ${sids.length === 1 ? 'it' : 'them'} before publishing.`,
      details: { sids },
    };
  },

  publish: (tx, { row, revision, now }) =>
    publishDraft(tx, row, readTldrPayload(row?.draftPayload), { revisionId: revision.id, fingerprint: revision.sentencesFingerprint, now }),
};
