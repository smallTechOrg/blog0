import { z } from 'zod';

import type { ImageUploadResponse } from '@/lib/api/dto';
import { imageMarkdown } from '@/lib/media/image-markdown';
import { findArticle } from '@/server/articles/repo';
import { getConfig } from '@/server/config';
import { apiResult, ApiError, payloadTooLarge, withApi } from '@/server/http/api';
import { probeImage } from '@/server/media/image-probe';
import { cleanOriginalFilename, formFile, logMediaUpload, logUploadRejections, readUpload, storeUpload } from '@/server/media/ingest';
import { insertMediaAsset } from '@/server/media/repo';
import { getCurrentSite } from '@/server/site/current';

// POST /api/admin/uploads/images (spec/api.md; capability media-images). Multipart: `file`
// (required), `alt` (≤ 200, default ''), `caption?` (≤ 200), `articleId?` (uuid of an article in
// this site, else 404). 201 ImageUploadResponse. Errors: PAYLOAD_TOO_LARGE, UNSUPPORTED_MEDIA
// (incl. SVG), IMAGE_TOO_LARGE, VALIDATION_FAILED.

export const dynamic = 'force-dynamic';

const fieldsSchema = z.object({
  alt: z.string().trim().max(200).default(''),
  caption: z.string().trim().max(200).optional(),
  articleId: z.string().trim().optional(),
});

function maxImageBytes(): number {
  return getConfig().maxImageMb * 1024 * 1024;
}

function textField(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === 'string' ? value : undefined;
}

export const POST = withApi(
  {
    auth: 'admin',
    body: 'multipart',
    maxBytes: maxImageBytes,
    summarizeInput: (form) => ({ hasFile: form.get('file') instanceof File, articleId: textField(form, 'articleId') ?? null }),
    summarizeOutput: (d) => {
      const a = (d as ImageUploadResponse | null)?.asset;
      return a ? { asset_id: a.id, mime: a.mimeType, bytes: a.bytes, width: a.width, height: a.height } : {};
    },
  },
  async ({ auth, body, requestId }) => {
    const parsed = fieldsSchema.safeParse({
      alt: textField(body, 'alt'),
      caption: textField(body, 'caption'),
      articleId: textField(body, 'articleId'),
    });
    if (!parsed.success) {
      throw new ApiError('VALIDATION_FAILED', 400, 'Some fields are missing or invalid.', z.flattenError(parsed.error));
    }
    const { alt, caption } = parsed.data;
    const articleId = parsed.data.articleId || null;
    if (articleId !== null && !(await findArticle(auth.user.siteId, articleId))) {
      throw new ApiError('NOT_FOUND', 404, 'No such article in this site.');
    }

    const maxBytes = maxImageBytes();
    const rules = {
      maxBytes,
      tooLarge: () => payloadTooLarge(maxBytes),
      empty: () => new ApiError('VALIDATION_FAILED', 400, 'That file is empty.', { fieldErrors: { file: ['The file is empty'] } }),
    };
    const site = await getCurrentSite();
    const context: Record<string, unknown> = { request_id: requestId, article_id: articleId ?? undefined };
    return logUploadRejections('image', context, async () => {
      const file = formFile(body, 'Attach the file as the "file" field.');
      const buffer = await readUpload(file, rules);
      context.bytes = buffer.length;
      const probe = probeImage(buffer);
      context.mime = probe.mime;
      const row = await storeUpload({ siteSlug: site.slug, kind: 'image', mime: probe.mime, buffer, rules, requestId }, (stored) =>
        insertMediaAsset({
          siteId: site.id,
          kind: 'image',
          storageKey: stored.key,
          originalFilename: cleanOriginalFilename(file.name),
          mimeType: probe.mime,
          byteSize: stored.size,
          sha256: stored.sha256,
          width: probe.width,
          height: probe.height,
          articleId,
          createdBy: auth.user.id,
        }),
      );
      logMediaUpload('image', 'ok', { ...context, bytes: row.byteSize, width: probe.width, height: probe.height });
      const url = `/media/${row.storageKey}`;
      const response: ImageUploadResponse = {
        asset: { id: row.id, key: row.storageKey, url, mimeType: probe.mime, bytes: row.byteSize, width: probe.width, height: probe.height },
        markdown: imageMarkdown(alt, url, caption),
      };
      return apiResult(response, { status: 201 });
    });
  },
);
