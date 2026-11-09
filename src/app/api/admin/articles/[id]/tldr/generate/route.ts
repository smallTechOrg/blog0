import type { GenerateTldrResponse } from '@/lib/api/dto';
import { actorOf, idParam, summarizeTldr } from '@/server/articles/http';
import { revisionBody } from '@/server/articles/schemas';
import { generateTldr } from '@/server/articles/tldr';
import { withApi } from '@/server/http/api';

// POST /api/admin/articles/:id/tldr/generate — the ONLY LLM call in blog0 (Jev, one explicit click).
// Errors: CONFLICT, GENERATION_IN_PROGRESS, JEV_*, LLM_* (failed GenerationDto in error.details.generation).

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export const POST = withApi(
  {
    auth: 'admin',
    body: revisionBody,
    summarizeInput: (b) => ({ revisionId: b.revisionId }),
    summarizeOutput: summarizeTldr,
  },
  async ({ auth, params, body, requestId }): Promise<GenerateTldrResponse> =>
    generateTldr(actorOf(auth), idParam(params), body.revisionId, requestId),
);
