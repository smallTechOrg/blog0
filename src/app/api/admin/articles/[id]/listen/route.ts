import type { GetListenResponse, ListenResponse } from '@/lib/api/dto-phase3';
import { actorOf, idParam } from '@/server/articles/http';
import { withApi } from '@/server/http/api';
import { getListenState, listenSaveBody, saveMarks } from '@/server/listen/sync';

// GET /api/admin/articles/:id/listen — ListenStateDto (status, paragraphs, draft audio + marks, stale report, published summary).
// PUT /api/admin/articles/:id/listen — save the tap-along sync (CONFLICT, LISTEN_NO_AUDIO, MARKS_INVALID).
// Upload / remove the recording: …/audio (S3.2). Never calls the AI.

export const dynamic = 'force-dynamic';

/** Output summary: status + counts only (spec/architecture.md §7). */
function summarizeListen(data: unknown): Record<string, unknown> {
  const d = data as { listen?: ListenLike } & ListenLike;
  const l: ListenLike = d?.listen ?? d;
  return { listen_status: l?.status, paragraphs: l?.paragraphs?.length, marks: l?.marks?.length, has_audio: !!l?.audio };
}

interface ListenLike {
  status?: string;
  paragraphs?: unknown[];
  marks?: unknown[];
  audio?: unknown;
}

export const GET = withApi(
  { auth: 'admin', summarizeOutput: summarizeListen },
  async ({ auth, params }): Promise<GetListenResponse> => getListenState(auth.user.siteId, idParam(params)),
);

export const PUT = withApi(
  {
    auth: 'admin',
    body: listenSaveBody,
    summarizeInput: (b) => ({ revisionId: b.revisionId, marks: b.marks.length }),
    summarizeOutput: summarizeListen,
  },
  async ({ auth, params, body }): Promise<ListenResponse> => ({ listen: await saveMarks(actorOf(auth), idParam(params), body) }),
);
