import 'server-only';

import { eq, max } from 'drizzle-orm';

import type { NewsletterSettingsResponse, NewsletterStatusDto } from '@/lib/api/dto';

import { getConfig } from '../../config';
import { getDb } from '../../db/client';
import { newsletterSubscriber } from '../../db/schema';
import { mailStatus } from '../mail';
import * as listRepo from '../repo';
import { getNewsletterSender } from '../sender';
import type { NewsletterSender } from '../sender/types';
import { newsletterSettingsFrom } from '../settings';

import { healthWithTimeout } from './send';
import { siteRowById } from './service';
import { digestStatus } from './triggers';

// Admin → Site → Newsletter (spec/api.md GET/PATCH /api/admin/newsletter/settings): the settings
// plus a read-only status card — sender kind + health (3 s healthcheck, listmonk only), mail
// transport, subscriber counts, last sync, and the digest window in digest mode.

async function lastSyncAt(siteId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ at: max(newsletterSubscriber.providerSyncedAt) })
    .from(newsletterSubscriber)
    .where(eq(newsletterSubscriber.siteId, siteId));
  const at = row?.at as Date | string | null | undefined;
  return at ? new Date(at).toISOString() : null;
}

export async function newsletterStatus(siteId: string, options: { sender?: NewsletterSender; now?: Date } = {}): Promise<NewsletterStatusDto> {
  const sender = options.sender ?? getNewsletterSender();
  const siteRow = await siteRowById(getDb(), siteId);
  const listmonk = getConfig().newsletter.listmonk;
  let healthy: boolean | null = null;
  let message: string | null = null;
  let listName: string | null = null;
  if (sender.kind === 'listmonk') {
    const health = await healthWithTimeout(sender);
    healthy = health.ok;
    message = health.message;
    listName = health.listName ?? null;
  } else {
    message = (await sender.healthcheck()).message;
  }
  return {
    sender: {
      kind: sender.kind,
      configured: sender.kind === 'stub' ? true : listmonk !== null,
      listId: sender.kind === 'listmonk' && listmonk ? String(listmonk.listId) : null,
      listName,
      lastSyncAt: await lastSyncAt(siteId),
      healthy,
      message,
      trackingPublic: await sender.trackingPublic().catch(() => true),
    },
    mail: mailStatus(),
    counts: await listRepo.countsOf(getDb(), siteId),
    digest: siteRow.newsletterMode === 'digest' ? await digestStatus(siteRow, options.now) : null,
  };
}

export async function newsletterSettingsResponse(siteId: string, options: { sender?: NewsletterSender; now?: Date } = {}): Promise<NewsletterSettingsResponse> {
  const siteRow = await siteRowById(getDb(), siteId);
  return { settings: newsletterSettingsFrom(siteRow), status: await newsletterStatus(siteId, options) };
}
