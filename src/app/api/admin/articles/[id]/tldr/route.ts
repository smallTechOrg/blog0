import type { ClearDeckResponse, GetTldrResponse, SaveDeckResponse } from '@/lib/api/dto';
import { actorOf, idParam, summarizeTldr } from '@/server/articles/http';
import { saveDeckBody } from '@/server/articles/schemas';
import { clearDeck, getTldrState, saveDeck } from '@/server/articles/tldr';
import { withApi } from '@/server/http/api';

// GET    /api/admin/articles/:id/tldr — TldrStateDto (status, bounds, sentences, draft, published, latest run).
// PUT    /api/admin/articles/:id/tldr — save the hand-edited deck (1–12 sids; text resolved server-side).
// DELETE /api/admin/articles/:id/tldr — clear the draft deck (published deck untouched).

export const dynamic = 'force-dynamic';

export const GET = withApi(
  { auth: 'admin', summarizeOutput: summarizeTldr },
  async ({ auth, params }): Promise<GetTldrResponse> => getTldrState(auth.user.siteId, idParam(params)),
);

export const PUT = withApi(
  {
    auth: 'admin',
    body: saveDeckBody,
    summarizeInput: (b) => ({
      revisionId: b.revisionId,
      slides: b.slides.length,
      writerSlides: b.slides.filter((s) => s.source === 'writer').length,
    }),
    summarizeOutput: summarizeTldr,
  },
  async ({ auth, params, body }): Promise<SaveDeckResponse> => ({ tldr: await saveDeck(actorOf(auth), idParam(params), body) }),
);

export const DELETE = withApi(
  { auth: 'admin', summarizeOutput: summarizeTldr },
  async ({ auth, params }): Promise<ClearDeckResponse> => ({ tldr: await clearDeck(actorOf(auth), idParam(params)) }),
);
