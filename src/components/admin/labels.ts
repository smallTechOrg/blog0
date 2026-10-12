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
  unavailable: 'later phase',
};

/** "Read ✓", "TLDR stale", "Listen later phase". */
export function chipLabel(chip: FormatChipDto): string {
  const label = FORMATS[chip.kind]?.label ?? chip.kind;
  if (chip.kind === 'read') return chip.status === 'ready' ? `${label} ✓` : `${label} ${FORMAT_STATUS_LABEL[chip.status]}`;
  return `${label} ${FORMAT_STATUS_LABEL[chip.status] ?? chip.status}`;
}

export function boundsHint(bounds: TldrStateDto['bounds']): string {
  if (!bounds) return 'No eligible sentences yet — Jev needs sentences of at least 5 words.';
  const span = bounds.min === bounds.max ? String(bounds.min) : `${bounds.min}–${bounds.max}`;
  return `Jev will pick ${span} lines for this length`;
}

const nf = new Intl.NumberFormat('en-US');

/** "Jev · <model> · <promptVersion> · <tokens> tokens · $<cost 4 dp> | cost n/a · <name> · <relative time>" */
export function generationMeta(g: GenerationDto, now: Date, timeZone: string): string {
  const tokens = g.totalTokens === null ? '?' : nf.format(g.totalTokens);
  const cost = g.costUsd === null ? 'cost n/a' : `$${g.costUsd.toFixed(4)}`;
  const when = relativeTime(g.finishedAt ?? g.startedAt, now, timeZone);
  return ['Jev', g.model, g.promptVersion, `${tokens} tokens`, cost, g.requestedBy, when].filter(Boolean).join(' · ');
}
