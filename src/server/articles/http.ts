import 'server-only';

import type { AdminAuth } from '../auth/guard';
import type { ActorContext } from './service';

// Small helpers shared by the /api/admin/articles/* route handlers.

export function actorOf(auth: AdminAuth): ActorContext {
  return { siteId: auth.user.siteId, user: auth.user };
}

/** The `[id]` route param (malformed ids are answered 404 by the services). */
export function idParam(params: Record<string, string | string[] | undefined>): string {
  const raw = params.id;
  return Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
}

/** Output summaries: counts and ids only (spec/architecture.md §7). */
export function summarizeArticle(data: unknown): Record<string, unknown> {
  const a = (data as { article?: { id?: string; currentRevision?: { number?: number }; status?: string } } | null)?.article;
  return a ? { article_id: a.id, revision: a.currentRevision?.number, status: a.status } : {};
}

export function summarizeTldr(data: unknown): Record<string, unknown> {
  const d = data as { tldr?: TldrLike; generation?: { id?: string; status?: string } } & TldrLike;
  const t: TldrLike = d?.tldr ?? d;
  return {
    tldr_status: t?.status,
    sentences: t?.sentences?.length,
    slides: t?.draft?.slides?.length ?? 0,
    ...(d?.generation ? { generation_id: d.generation.id, generation_status: d.generation.status } : {}),
  };
}

interface TldrLike {
  status?: string;
  sentences?: unknown[];
  draft?: { slides?: unknown[] } | null;
}
