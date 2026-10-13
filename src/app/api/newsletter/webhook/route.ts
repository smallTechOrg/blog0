import { createHash, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import type { NewsletterWebhookResponse } from '@/lib/api/dto';
import { getConfig } from '@/server/config';
import { ApiError, withApi } from '@/server/http/api';
import { log, maskEmail } from '@/server/log';
import { webhookBody } from '@/server/newsletter/schemas';
import { suppressByEmail } from '@/server/newsletter/service';
import { getCurrentSite } from '@/server/site/current';

// POST /api/newsletter/webhook (spec/api.md; architecture §13.3 "Webhook"): a provider tells blog0
// about an unsubscribe / bounce / complaint. `Authorization: Bearer <BLOG0_NEWSLETTER_WEBHOOK_SECRET>`
// compared in constant time; no secret configured → 404 (the endpoint does not exist); wrong or
// missing → 401 WEBHOOK_UNAUTHORIZED, checked BEFORE the body is read. A known address → suppression
// (source `webhook`) + event + provider blocklist → `{ accepted: true }` (idempotent); unknown → `{ accepted: false }`, nothing written.

export const dynamic = 'force-dynamic';

const REASON = { unsubscribe: 'unsubscribed', bounce: 'bounced', complaint: 'complaint' } as const;

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function bearerMatches(request: Request, secret: string): boolean {
  const header = request.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return false;
  return timingSafeEqual(digest(m[1].trim()), digest(secret));
}

export const POST = withApi({ auth: 'none', csrf: false }, async ({ request, requestId }): Promise<NewsletterWebhookResponse> => {
  const secret = getConfig().newsletter.webhookSecret;
  if (secret === null) throw new ApiError('NOT_FOUND', 404, 'Not found.');
  if (!bearerMatches(request, secret.reveal())) throw new ApiError('WEBHOOK_UNAUTHORIZED', 401, 'The webhook secret is missing or wrong.');

  let raw: unknown;
  try {
    const text = await request.text();
    raw = text.trim() === '' ? {} : JSON.parse(text);
  } catch {
    throw new ApiError('VALIDATION_FAILED', 400, 'The request body is not valid JSON.');
  }
  const parsed = webhookBody.safeParse(raw);
  if (!parsed.success) throw new ApiError('VALIDATION_FAILED', 400, 'Some fields are missing or invalid.', z.flattenError(parsed.error));
  const body = parsed.data;

  const site = await getCurrentSite();
  const details: Record<string, unknown> = { event: body.event };
  if (body.reason !== undefined) details.reason = body.reason;
  if (body.occurredAt !== undefined) details.occurredAt = body.occurredAt;
  if (body.providerRef !== undefined) details.providerRef = body.providerRef;
  const { accepted, subscriber } = await suppressByEmail(site.id, body.email, { reason: REASON[body.event], source: 'webhook', details });
  log.info('newsletter.sync', {
    trigger: 'webhook',
    request_id: requestId,
    event: body.event,
    email_masked: maskEmail(body.email),
    subscriber_id: subscriber?.id,
    accepted,
  });
  return { accepted };
});
