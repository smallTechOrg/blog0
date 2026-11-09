import 'server-only';

import { z } from 'zod';

import type { IssueStatus } from '@/lib/api/dto';

import { ApiError } from '../../http/api';

// Small request helpers shared by the /api/admin/newsletter/issues/** route handlers.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The `[id]` param, or 404 "That issue isn’t here." for anything that is not a uuid. */
export function issueIdOf(params: Record<string, string | string[] | undefined>): string {
  const id = typeof params.id === 'string' ? params.id : '';
  if (!UUID_RE.test(id)) throw new ApiError('NOT_FOUND', 404, 'That issue isn’t here.');
  return id;
}

const statusParam = z.enum(['draft', 'sending', 'sent', 'failed']);

/** `?status=` on the issue list (optional; anything else → 400). */
export function issueStatusQuery(request: Request): IssueStatus | undefined {
  const raw = new URL(request.url).searchParams.get('status');
  if (raw === null || raw === '') return undefined;
  const parsed = statusParam.safeParse(raw);
  if (!parsed.success) throw new ApiError('VALIDATION_FAILED', 400, 'status must be one of draft, sending, sent, failed.');
  return parsed.data;
}
