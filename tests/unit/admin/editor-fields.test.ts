import { describe, expect, it } from 'vitest';

import { changedFields, fieldsFrom, mergeAfterSave, wordCount } from '@/components/admin/editor/fields';
import type { ArticleDetailDto } from '@/lib/api/dto';

function article(over: Partial<ArticleDetailDto> = {}, rev: Partial<ArticleDetailDto['currentRevision']> = {}): ArticleDetailDto {
  return {
    id: 'a1', slug: 'hello-world', slugLocked: false, status: 'draft', topic: 'AI', bylineName: 'Sai',
    isFeatured: false, featuredRank: null, inProgress: false, firstPublishedAt: null, lastPublishedAt: null,
    currentRevision: {
      id: 'r1', number: 1, createdAt: '2026-10-12T10:00:00Z', createdBy: 'Sai',
      title: 'Hello world', dek: 'A dek', bodyMd: 'Body text here.', wordCount: 3, eligibleSentenceCount: 0, ...rev,
    },
    publishedRevisionId: null, revisionCount: 1, formats: [], topics: ['AI'], publicUrl: null, ...over,
  };
}

describe('changedFields', () => {
  it('is empty when nothing changed', () => {
    const a = article();

    expect(changedFields(a, fieldsFrom(a))).toEqual({});
  });

  it('sends only the fields the writer changed', () => {
    const a = article();
    const fields = { ...fieldsFrom(a), bodyMd: 'New body.', topic: 'Tech', isFeatured: true, featuredRank: 2 };

    expect(changedFields(a, fields)).toEqual({ bodyMd: 'New body.', topic: 'Tech', isFeatured: true, featuredRank: 2 });
  });

  it('never sends the slug once it is locked', () => {
    const a = article({ slugLocked: true });

    expect(changedFields(a, { ...fieldsFrom(a), slug: 'other' })).toEqual({});
  });
});

describe('mergeAfterSave', () => {
  it("adopts the server's values for fields untouched since the save started (e.g. a re-derived slug)", () => {
    const before = article();
    const sent = { ...fieldsFrom(before), title: 'New title' };
    const local = { ...sent, bodyMd: 'Typed while saving.' };
    const server = article({ slug: 'new-title' }, { title: 'New title', number: 2 });

    const merged = mergeAfterSave(sent, local, server);

    expect(merged.slug).toBe('new-title');
    expect(merged.title).toBe('New title');
    expect(merged.bodyMd).toBe('Typed while saving.');
    expect(changedFields(server, merged)).toEqual({ bodyMd: 'Typed while saving.' });
  });
});

describe('wordCount', () => {
  it('counts whitespace-separated words and treats empty text as zero', () => {
    expect(wordCount('')).toBe(0);
    expect(wordCount('  one two\n\nthree  ')).toBe(3);
  });
});
