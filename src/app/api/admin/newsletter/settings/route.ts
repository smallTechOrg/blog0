import type { NewsletterSettingsResponse } from '@/lib/api/dto';
import { withApi } from '@/server/http/api';
import { newsletterSettingsResponse } from '@/server/newsletter/issues/status';
import { settingsPatch } from '@/server/newsletter/schemas';
import { updateNewsletterSettings } from '@/server/newsletter/settings';

// GET   /api/admin/newsletter/settings — settings + the read-only status card (sender health is a
//       3 s healthcheck on the listmonk adapter, null for the stub).
// PATCH /api/admin/newsletter/settings — mode / autoSend / digest thresholds / consent text+version.
//       Changing the mode stamps modeSetAt; a new consent text without a version bumps it. Never sends.

export const dynamic = 'force-dynamic';

export const GET = withApi(
  { auth: 'admin', summarizeOutput: (d) => ({ mode: (d as NewsletterSettingsResponse).settings.mode, sender: (d as NewsletterSettingsResponse).status.sender.kind }) },
  async ({ auth }): Promise<NewsletterSettingsResponse> => newsletterSettingsResponse(auth.user.siteId),
);

export const PATCH = withApi(
  { auth: 'admin', body: settingsPatch, summarizeInput: (b) => ({ fields: Object.keys(b) }) },
  async ({ auth, body }): Promise<NewsletterSettingsResponse> => {
    await updateNewsletterSettings(auth.user.siteId, body, { userId: auth.user.id });
    return newsletterSettingsResponse(auth.user.siteId);
  },
);
