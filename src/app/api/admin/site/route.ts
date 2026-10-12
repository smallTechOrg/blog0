import type { SiteSettingsResponse } from '@/lib/api/dto-phase2';
import { withApi } from '@/server/http/api';
import { getSiteSettings, siteSettingsPatchBody, updateSiteSettings } from '@/server/site/service';

// GET   /api/admin/site — the editable site settings (Admin → Site).
// PATCH /api/admin/site — any subset of them; home and /about show the change on next load.

export const dynamic = 'force-dynamic';

export const GET = withApi(
  { auth: 'admin' },
  async ({ auth }): Promise<SiteSettingsResponse> => ({ site: await getSiteSettings(auth.user.siteId) }),
);

export const PATCH = withApi(
  {
    auth: 'admin',
    body: siteSettingsPatchBody,
    // Field names and lengths only — never the texts or the contact address.
    summarizeInput: (b) => ({
      fields: Object.keys(b),
      aboutBodyChars: b.aboutBodyMd?.length,
    }),
  },
  async ({ auth, body }): Promise<SiteSettingsResponse> => ({
    site: await updateSiteSettings(auth.user.siteId, body, { userId: auth.user.id }),
  }),
);
