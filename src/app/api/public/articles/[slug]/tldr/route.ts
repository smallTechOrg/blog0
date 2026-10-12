import type { PublicTldrDto } from '@/lib/api/dto-phase2';
import { ApiError, withApi, type RouteContext } from '@/server/http/api';
import { loadPublishedArticle } from '@/server/public/articles';

// GET /api/public/articles/:slug/tldr (spec/api.md Phase 2) — the published deck for a card's
// TLDR overlay. Public, read-only, published-only: unknown, malformed, unpublished slugs and
// articles without a published deck are 404 NOT_FOUND. Only reader-facing deck data leaves the
// server — slide texts, the AI disclosure, times — never sids, Jev reasons, generation ids or
// cost. Cacheable for 60 s (`Cache-Control: public, max-age=60`); errors stay `no-store`.

export const dynamic = 'force-dynamic';

const NOT_FOUND_MESSAGE = 'That article has no published summary.';

const handler = withApi(
  {
    auth: 'none',
    summarizeOutput: (d) => ({ slides: (d as PublicTldrDto).slides.length }),
  },
  async ({ params }): Promise<PublicTldrDto> => {
    const slug = typeof params.slug === 'string' ? params.slug : '';
    const page = await loadPublishedArticle(slug);
    const a = page?.article;
    if (!a || !a.deck || a.times.tldr == null) throw new ApiError('NOT_FOUND', 404, NOT_FOUND_MESSAGE);
    return {
      slug: a.slug,
      title: a.title,
      topic: a.topic,
      dek: a.dek,
      meta: a.publishedLabel + ' · ' + a.times.read + ' min read',
      slides: a.deck.slides.map((s) => ({ text: s.text })),
      disclosure: a.deck.disclosure,
      times: { read: a.times.read, tldr: a.times.tldr, listen: a.times.listen },
      shareUrl: a.deck.shareUrl,
    };
  },
);

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const res = await handler(request, context);
  if (res.status === 200) res.headers.set('cache-control', 'public, max-age=60');
  return res;
}
