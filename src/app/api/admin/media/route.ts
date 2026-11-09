import type { MediaLibraryResponse } from '@/lib/api/dto';
import { withApi } from '@/server/http/api';
import { listImageLibrary } from '@/server/media/library';
import { getCurrentSite } from '@/server/site/current';

// GET /api/admin/media (spec/api.md → media; capability media-library): every uploaded image of
// the site, newest first, with the articles whose current or published Markdown shows it.
// 401 without a session.

export const dynamic = 'force-dynamic';

export const GET = withApi(
  {
    auth: 'admin',
    summarizeOutput: (d) => ({ images: (d as MediaLibraryResponse | null)?.items.length ?? 0 }),
  },
  async (): Promise<MediaLibraryResponse> => {
    const site = await getCurrentSite();
    return { items: await listImageLibrary(site.id) };
  },
);
