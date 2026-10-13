import type { ListenResponse } from '@/lib/api/dto';
import { actorOf, idParam } from '@/server/articles/http';
import { withApi } from '@/server/http/api';
import { configuredAudioLimits, removeAudio, uploadAudio } from '@/server/listen/ingest';
import { summarizeListen } from '@/server/listen/sync';
import { formFile } from '@/server/media/ingest';

// POST   /api/admin/articles/:id/audio — multipart `file`: upload / replace the draft recording
//        (200 ListenResponse, status 'ready', marks [], timing 'estimated', uploadFingerprint = the
//        current paragraphs fingerprint). 413 / 415 / 422 per spec/api.md.
// DELETE /api/admin/articles/:id/audio — remove the draft recording (200, status 'missing'). Idempotent.

export const dynamic = 'force-dynamic';
/** Large uploads on a slow link: give the handler up to two minutes (spec/api.md). */
export const maxDuration = 120;

export const POST = withApi(
  {
    auth: 'admin',
    body: 'multipart',
    maxBytes: () => configuredAudioLimits().maxBytes,
    summarizeInput: (form) => {
      const file = form.get('file');
      return file instanceof File ? { file_bytes: file.size, file_type: file.type || null } : { file_bytes: null };
    },
    summarizeOutput: summarizeListen,
  },
  async ({ auth, params, body, requestId }): Promise<ListenResponse> => {
    const file = formFile(body, 'Attach the recording as the multipart field "file".');
    return { listen: await uploadAudio(idParam(params), file, actorOf(auth), { requestId }) };
  },
);

export const DELETE = withApi(
  { auth: 'admin', summarizeOutput: summarizeListen },
  async ({ auth, params, requestId }): Promise<ListenResponse> => ({ listen: await removeAudio(idParam(params), actorOf(auth), { requestId }) }),
);
