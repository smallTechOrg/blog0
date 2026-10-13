// Display strings for the desk and editor (spec/ui.md §4). Pure.

import type { ArticleListItemDto, ArticleStatus, FormatChipDto, GenerationDto, TldrStateDto } from '@/lib/api/dto';
import { FORMATS, type FormatStatus } from '@/lib/formats/registry';

import { relativeTime } from './relative-time';

export const ARTICLE_STATUS_LABEL: Record<ArticleStatus, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  approved: 'Approved',
  published: 'Published',
};

export function statusLabel(item: Pick<ArticleListItemDto, 'status' | 'hasUnpublishedChanges'>): string {
  const base = ARTICLE_STATUS_LABEL[item.status] ?? item.status;
  return item.status === 'published' && item.hasUnpublishedChanges ? `${base} · unpublished changes` : base;
}

export const FORMAT_STATUS_LABEL: Record<FormatStatus, string> = {
  missing: 'missing',
  generating: 'generating',
  failed: 'failed',
  ready: 'ready',
  stale: 'stale',
  text_changed: 'text changed',
};

/** "Read ✓", "TLDR stale", "Listen text changed". */
export function chipLabel(chip: FormatChipDto): string {
  const label = FORMATS[chip.kind]?.label ?? chip.kind;
  if (chip.kind === 'read') return chip.status === 'ready' ? `${label} ✓` : `${label} ${FORMAT_STATUS_LABEL[chip.status]}`;
  return `${label} ${FORMAT_STATUS_LABEL[chip.status] ?? chip.status}`;
}

/**
 * The bounds hint next to Generate (spec/ui.md §4): "Jev will pick the top <k> lines for this length"
 * (k = `bounds.target`), "all <k> lines" when k equals the eligible sentence count.
 */
export function boundsHint(bounds: TldrStateDto['bounds'], sentenceCount?: number): string {
  if (!bounds) return 'No eligible sentences yet — Jev needs sentences of at least 5 words.';
  const k = bounds.target;
  if (sentenceCount !== undefined && k >= sentenceCount) {
    return k === 1 ? 'Jev will pick the only line for this length' : `Jev will pick all ${k} lines for this length`;
  }
  return k === 1 ? 'Jev will pick the top line for this length' : `Jev will pick the top ${k} lines for this length`;
}

/**
 * The one relevance formatter (spec/ui.md §4): "relevance 0.82" — two decimals, display only (sorting
 * uses the raw number). Null (no score) renders nothing, so this returns null.
 */
export function relevanceLabel(relevance: number | null | undefined): string | null {
  if (relevance === null || relevance === undefined || !Number.isFinite(relevance)) return null;
  return `relevance ${relevance.toFixed(2)}`;
}

const nf = new Intl.NumberFormat('en-US');

function plural(n: number, one: string, many: string): string {
  return `${nf.format(n)} ${n === 1 ? one : many}`;
}

/**
 * "Jev · <model> · <promptVersion> · ranked <N> sentences[ in <attempts> requests] · <tokens> tokens ·
 * $<cost 4 dp> | cost n/a · <name> · <relative time>". The "ranked" part is left out when the
 * generation sent no sentences (a pre-Phase-8 or failed-before-sending row).
 */
export function generationMeta(g: GenerationDto, now: Date, timeZone: string): string {
  const ranked =
    g.sentenceCount > 0
      ? `ranked ${plural(g.sentenceCount, 'sentence', 'sentences')}${g.attempts > 1 ? ` in ${nf.format(g.attempts)} requests` : ''}`
      : '';
  const tokens = g.totalTokens === null ? '?' : nf.format(g.totalTokens);
  const cost = g.costUsd === null ? 'cost n/a' : `$${g.costUsd.toFixed(4)}`;
  const when = relativeTime(g.finishedAt ?? g.startedAt, now, timeZone);
  return ['Jev', g.model, g.promptVersion, ranked, `${tokens} tokens`, cost, g.requestedBy, when].filter(Boolean).join(' · ');
}
