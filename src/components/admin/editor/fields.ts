// Editor form state ↔ ArticleDetailDto (spec/api.md PATCH /api/admin/articles/:id). Pure.

import type { ArticleDetailDto, UpdateArticleRequest } from '@/lib/api/dto';

export interface EditorFields {
  title: string;
  dek: string;
  bodyMd: string;
  topic: string;
  slug: string;
  bylineName: string;
  isFeatured: boolean;
  featuredRank: number | null;
  inProgress: boolean;
}

export type FieldPatch = Omit<UpdateArticleRequest, 'baseRevisionId'>;

const KEYS: Array<keyof EditorFields> = [
  'title', 'dek', 'bodyMd', 'topic', 'slug', 'bylineName', 'isFeatured', 'featuredRank', 'inProgress',
];

export function fieldsFrom(a: ArticleDetailDto): EditorFields {
  return {
    title: a.currentRevision.title,
    dek: a.currentRevision.dek,
    bodyMd: a.currentRevision.bodyMd,
    topic: a.topic,
    slug: a.slug,
    bylineName: a.bylineName,
    isFeatured: a.isFeatured,
    featuredRank: a.featuredRank,
    inProgress: a.inProgress,
  };
}

/** The PATCH body (minus baseRevisionId): only what differs from the saved article. */
export function changedFields(saved: ArticleDetailDto, fields: EditorFields): FieldPatch {
  const base = fieldsFrom(saved);
  const patch: Record<string, unknown> = {};
  for (const k of KEYS) {
    if (k === 'slug' && saved.slugLocked) continue;
    if (fields[k] !== base[k]) patch[k] = fields[k];
  }
  return patch as FieldPatch;
}

/**
 * After a save resolves: fields the writer did not touch since the request left take the
 * server's value (the server may normalise them, e.g. re-derive the slug); fields typed into
 * meanwhile keep the writer's value. Nothing typed is ever discarded.
 */
export function mergeAfterSave(sent: EditorFields, local: EditorFields, server: ArticleDetailDto): EditorFields {
  const fromServer = fieldsFrom(server);
  const out = { ...local } as Record<keyof EditorFields, unknown>;
  for (const k of KEYS) if (local[k] === sent[k]) out[k] = fromServer[k];
  return out as unknown as EditorFields;
}

export function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}
