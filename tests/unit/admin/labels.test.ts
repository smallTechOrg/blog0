import { describe, expect, it } from 'vitest';

import { boundsHint, chipLabel, generationMeta, relevanceLabel, statusLabel } from '@/components/admin/labels';
import type { ArticleListItemDto, GenerationDto } from '@/lib/api/dto';

const NOW = new Date('2026-10-12T12:00:00Z');

function gen(over: Partial<GenerationDto> = {}): GenerationDto {
  return {
    id: 'g1', status: 'succeeded', model: 'typesafe/jev-1.13', promptVersion: 'jev-rank-v1',
    requestedBy: 'Sai', startedAt: '2026-10-12T11:55:00Z', finishedAt: '2026-10-12T11:55:00Z', latencyMs: 9000, attempts: 1,
    sentenceCount: 42,
    promptTokens: 1000, completionTokens: 234, totalTokens: 1234, costUsd: 0.00123456,
    picks: [], errorCode: null, errorMessage: null, ...over,
  };
}

describe('generationMeta', () => {
  it('prints model, prompt version, sentences ranked, tokens, cost to 4 dp, who and when', () => {
    expect(generationMeta(gen(), NOW, 'UTC')).toBe(
      'Jev · typesafe/jev-1.13 · jev-rank-v1 · ranked 42 sentences · 1,234 tokens · $0.0012 · Sai · 5 min ago',
    );
  });

  it('names the request count when the article was ranked in several batches, and the singular for one sentence', () => {
    expect(generationMeta(gen({ sentenceCount: 1200, attempts: 3 }), NOW, 'UTC')).toContain(
      ' · ranked 1,200 sentences in 3 requests · ',
    );
    expect(generationMeta(gen({ sentenceCount: 1 }), NOW, 'UTC')).toContain(' · ranked 1 sentence · ');
  });

  it('leaves out the ranked part when no sentences were sent (a pre-Phase-8 generation)', () => {
    const meta = generationMeta(gen({ sentenceCount: 0, model: 'google/gemini-2.5-flash', promptVersion: 'jev-select-v1' }), NOW, 'UTC');
    expect(meta).toBe('Jev · google/gemini-2.5-flash · jev-select-v1 · 1,234 tokens · $0.0012 · Sai · 5 min ago');
  });

  it('never mentions a reason', () => {
    expect(generationMeta(gen(), NOW, 'UTC')).not.toMatch(/reason/i);
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
    expect(chipLabel({ kind: 'listen', status: 'text_changed', published: false, hasUnpublishedChanges: false })).toBe(
      'Listen text changed',
    );
  });

  it('describes the top-k deck Jev will pick (k = bounds.target)', () => {
    expect(boundsHint({ min: 5, max: 7, target: 6 }, 40)).toBe('Jev will pick the top 6 lines for this length');
    expect(boundsHint({ min: 5, max: 7, target: 6 })).toBe('Jev will pick the top 6 lines for this length');
    expect(boundsHint({ min: 3, max: 3, target: 3 }, 3)).toBe('Jev will pick all 3 lines for this length');
    expect(boundsHint({ min: 1, max: 1, target: 1 }, 1)).toBe('Jev will pick the only line for this length');
    expect(boundsHint(null, 0)).toBe('No eligible sentences yet — Jev needs sentences of at least 5 words.');
  });
});

describe('relevanceLabel', () => {
  it('prints the score with two decimals', () => {
    expect(relevanceLabel(0.8234)).toBe('relevance 0.82');
    expect(relevanceLabel(0.005)).toMatch(/^relevance 0\.0[01]$/);
    expect(relevanceLabel(0)).toBe('relevance 0.00');
    expect(relevanceLabel(1)).toBe('relevance 1.00');
  });

  it('renders nothing for a sentence without a score', () => {
    expect(relevanceLabel(null)).toBeNull();
    expect(relevanceLabel(undefined)).toBeNull();
    expect(relevanceLabel(Number.NaN)).toBeNull();
  });
});
