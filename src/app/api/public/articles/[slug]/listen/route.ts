import type { PublicListenDto } from '@/lib/api/dto-phase3';
import { ApiError, withApi, type RouteContext } from '@/server/http/api';
import { loadPublishedArticle } from '@/server/public/articles';

// GET /api/public/articles/:slug/listen (spec/api.md Phase 3) — the published recording + marks
// for a card's Listen overlay. Public, read-only, published-only: unknown, malformed and
// unpublished slugs and articles without a PUBLISHED Listen are 404 NOT_FOUND; a draft recording
// (synced or not) is never served. Only reader-facing data leaves the server — the media url,
// mime, duration, marks, times — never the asset id, storage key, fingerprints or uploader.
// Cacheable for 60 s (`Cache-Control: public, max-age=60`); errors stay `no-store`.

export const dynamic = 'force-dynamic';

const NOT_FOUND_MESSAGE = 'That article has no published recording.';

const handler = withApi(
  {
    auth: 'none',
    summarizeOutput: (d) => ({ marks: (d as PublicListenDto).marks.length }),
  },
  async ({ params }): Promise<PublicListenDto> => {
    const slug = typeof params.slug === 'string' ? params.slug : '';
    const page = await loadPublishedArticle(slug);
    const a = page?.article;
    if (!a || !a.listen || a.times.listen == null) throw new ApiError('NOT_FOUND', 404, NOT_FOUND_MESSAGE);
    return {
      slug: a.slug,
      title: a.title,
      topic: a.topic,
      dek: a.dek,
      meta: a.publishedLabel + ' · ' + a.times.read + ' min read',
      audio: { url: a.listen.audioUrl, mimeType: a.listen.mimeType, durationMs: a.listen.durationMs },
      marks: a.listen.marks.map((m) => ({ pid: m.pid, tMs: m.tMs })),
      bylineName: a.bylineName,
      times: { read: a.times.read, tldr: a.times.tldr, listen: a.times.listen },
      shareUrl: a.listen.shareUrl,
    };
  },
);

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const res = await handler(request, context);
  if (res.status === 200) res.headers.set('cache-control', 'public, max-age=60');
  return res;
}
