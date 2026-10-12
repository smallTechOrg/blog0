import { describe, expect, it } from 'vitest';

import { boundsHint, chipLabel, generationMeta, statusLabel } from '@/components/admin/labels';
import type { ArticleListItemDto, GenerationDto } from '@/lib/api/dto';

const NOW = new Date('2026-10-12T12:00:00Z');

function gen(over: Partial<GenerationDto> = {}): GenerationDto {
  return {
    id: 'g1', status: 'succeeded', model: 'google/gemini-2.5-flash', promptVersion: 'jev-select-v1',
    requestedBy: 'Sai', startedAt: '2026-10-12T11:55:00Z', finishedAt: '2026-10-12T11:55:00Z', latencyMs: 9000, attempts: 1,
    promptTokens: 1000, completionTokens: 234, totalTokens: 1234, costUsd: 0.00123456,
    picks: [], errorCode: null, errorMessage: null, ...over,
  };
}

describe('generationMeta', () => {
  it('prints model, prompt version, tokens, cost to 4 dp, who and when', () => {
    expect(generationMeta(gen(), NOW, 'UTC')).toBe(
      'Jev · google/gemini-2.5-flash · jev-select-v1 · 1,234 tokens · $0.0012 · Sai · 5 min ago',
    );
  });

  it('says "cost n/a" when the provider reported no cost and "? tokens" when usage is missing', () => {
    expect(generationMeta(gen({ costUsd: null, totalTokens: null }), NOW, 'UTC')).toContain('? tokens · cost n/a ·');
  });
});

describe('statusLabel / chipLabel / boundsHint', () => {
  it('labels the article status with unpublished changes', () => {
    const item = { status: 'published', hasUnpublishedChanges: true } as ArticleListItemDto;
    expect(statusLabel(item)).toBe('Published · unpublished changes');
    expect(statusLabel({ status: 'draft', hasUnpublishedChanges: false } as ArticleListItemDto)).toBe('Draft');
  });

  it('labels format chips per kind and status', () => {
    expect(chipLabel({ kind: 'read', status: 'ready', published: true, hasUnpublishedChanges: false })).toBe('Read ✓');
    expect(chipLabel({ kind: 'tldr', status: 'stale', published: true, hasUnpublishedChanges: true })).toBe('TLDR stale');
    expect(chipLabel({ kind: 'listen', status: 'unavailable', published: false, hasUnpublishedChanges: false })).toBe(
      'Listen later phase',
    );
  });

  it('describes the deck size Jev will aim for', () => {
    expect(boundsHint({ min: 5, max: 7, target: 6 })).toBe('Jev will pick 5–7 lines for this length');
    expect(boundsHint({ min: 3, max: 3, target: 3 })).toBe('Jev will pick 3 lines for this length');
    expect(boundsHint(null)).toBe('No eligible sentences yet — Jev needs sentences of at least 5 words.');
  });
});
