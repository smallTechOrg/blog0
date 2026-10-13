import 'server-only';

import type { RenderedArticle, RenderInput } from '@/lib/content/types';

import { RENDER_VERSION, renderArticle } from './render';

// In-memory LRU of rendered revisions (spec/architecture.md §4), keyed by
// `revisionId + ':' + RENDER_VERSION`. Revisions are immutable, so an entry never goes stale.
// Preview renders are NOT cached — call renderArticle() directly for those.
// Callers must treat the returned object as read-only (it is shared between requests).

export const RENDER_CACHE_MAX = 200;

const entries = new Map<string, Promise<RenderedArticle>>();

export function renderCacheKey(revisionId: string): string {
  return `${revisionId}:${RENDER_VERSION}`;
}

/** Renders a saved revision once per process (concurrent callers share one render). */
export function getRenderedRevision(revisionId: string, input: RenderInput): Promise<RenderedArticle> {
  const key = renderCacheKey(revisionId);
  const hit = entries.get(key);
  if (hit) {
    entries.delete(key);
    entries.set(key, hit);
    return hit;
  }

  const pending = renderArticle(input);
  entries.set(key, pending);
  pending.catch(() => {
    if (entries.get(key) === pending) entries.delete(key);
  });
  while (entries.size > RENDER_CACHE_MAX) {
    const oldest = entries.keys().next().value as string;
    entries.delete(oldest);
  }
  return pending;
}

export function renderCacheSize(): number {
  return entries.size;
}

export function resetRenderCacheForTests(): void {
  entries.clear();
}
