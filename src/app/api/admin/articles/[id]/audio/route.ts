import type { ListenResponse } from '@/lib/api/dto-phase3';
import { actorOf, idParam } from '@/server/articles/http';
import { ApiError, withApi } from '@/server/http/api';
import { configuredAudioLimits, removeAudio, uploadAudio } from '@/server/listen/ingest';

// POST   /api/admin/articles/:id/audio — multipart `file`: upload / replace the draft recording
//        (200 ListenResponse, status 'needs_sync', marks []). 413 / 415 / 422 per spec/api.md.
// DELETE /api/admin/articles/:id/audio — remove the draft recording (200, status 'missing'). Idempotent.

export const dynamic = 'force-dynamic';
/** Large uploads on a slow link: give the handler up to two minutes (spec/api.md). */
export const maxDuration = 120;

function summarizeListen(data: unknown): Record<string, unknown> {
  const l = (data as { listen?: { status?: string; audio?: { assetId?: string; durationMs?: number; bytes?: number } | null } } | null)?.listen;
  return l ? { listen_status: l.status, asset_id: l.audio?.assetId ?? null, duration_ms: l.audio?.durationMs ?? null, bytes: l.audio?.bytes ?? null } : {};
}

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
    const file = body.get('file');
    if (!(file instanceof File)) {
      throw new ApiError('VALIDATION_FAILED', 400, 'Attach the recording as the multipart field "file".', { fieldErrors: { file: ['required'] } });
    }
    return { listen: await uploadAudio(idParam(params), file, actorOf(auth), { requestId }) };
  },
);

export const DELETE = withApi(
  { auth: 'admin', summarizeOutput: summarizeListen },
  async ({ auth, params, requestId }): Promise<ListenResponse> => ({ listen: await removeAudio(idParam(params), actorOf(auth), { requestId }) }),
);
