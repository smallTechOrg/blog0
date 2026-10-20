import type { GetListenResponse, ListenResponse } from '@/lib/api/dto';
import { actorOf, idParam } from '@/server/articles/http';
import { withApi } from '@/server/http/api';
import { getListenState, listenSaveBody, saveMarks, summarizeListen } from '@/server/listen/sync';

// GET /api/admin/articles/:id/listen — ListenStateDto (status missing|ready|text_changed, paragraphs,
//     draft audio + stored marks, timing, upload baseline, published summary).
// PUT /api/admin/articles/:id/listen — INTERNAL / aligner-facing (the aligner writes marks here;
//     no admin UI calls it): stores a complete mark set (CONFLICT, LISTEN_NO_AUDIO, MARKS_INVALID);
//     never changes the status or the upload fingerprint.
// Upload / remove the recording: …/audio. Never calls the AI.

export const dynamic = 'force-dynamic';

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
