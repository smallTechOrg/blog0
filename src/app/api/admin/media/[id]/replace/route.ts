import type { MediaReplaceResponse } from '@/lib/api/dto';
import { getConfig } from '@/server/config';
import { ApiError, payloadTooLarge, withApi } from '@/server/http/api';
import { formFile, logMediaUpload, logUploadRejections } from '@/server/media/ingest';
import { replaceImage } from '@/server/media/library';
import { getCurrentSite } from '@/server/site/current';

// POST /api/admin/media/:id/replace (spec/api.md → media; capability media-library). Multipart
// `file` (PNG, JPEG, WebP or GIF, same limits as an upload). The file behind the image's
// `/media/<key>` address is replaced; the address — and so every article using it — is unchanged.
// 200 MediaReplaceResponse. Errors: 404 (no such image), 413, 415 (not an allowed image), 422.

export const dynamic = 'force-dynamic';

function maxImageBytes(): number {
  return getConfig().maxImageMb * 1024 * 1024;
}

export const POST = withApi(
  {
    auth: 'admin',
    body: 'multipart',
    maxBytes: maxImageBytes,
    summarizeInput: (form) => ({ hasFile: form.get('file') instanceof File }),
    summarizeOutput: (d) => {
      const item = (d as MediaReplaceResponse | null)?.item;
      return item ? { asset_id: item.id, mime: item.mimeType, bytes: item.bytes, width: item.width, height: item.height } : {};
    },
  },
  async ({ params, body, requestId }): Promise<MediaReplaceResponse> => {
    const raw = params.id;
    const assetId = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
    const maxBytes = maxImageBytes();
    const rules = {
      maxBytes,
      tooLarge: () => payloadTooLarge(maxBytes),
      empty: () => new ApiError('VALIDATION_FAILED', 400, 'That file is empty.', { fieldErrors: { file: ['The file is empty'] } }),
    };
    const site = await getCurrentSite();
    const context = { request_id: requestId, asset_id: assetId, op: 'replace' };
    return logUploadRejections('image', context, async () => {
      const file = formFile(body, 'Attach the new image as the "file" field.');
      const item = await replaceImage({ siteId: site.id, assetId, file, rules, requestId });
      logMediaUpload('image', 'ok', { ...context, bytes: item.bytes, width: item.width, height: item.height });
      return { item };
    });
  },
);
