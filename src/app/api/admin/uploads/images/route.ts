import { z } from 'zod';

import { findArticle } from '@/server/articles/repo';
import { getConfig } from '@/server/config';
import { apiResult, ApiError, withApi } from '@/server/http/api';
import { probeImage, type ImageMime } from '@/server/media/image-probe';
import { ingestUpload, logMediaUpload, storeMediaAsset } from '@/server/media/ingest';
import { getCurrentSite } from '@/server/site/current';

// POST /api/admin/uploads/images (spec/api.md Phase 3; capability media-images). Multipart:
// `file` (required), `alt` (≤ 200, default ''), `caption?` (≤ 200), `articleId?` (uuid of an
// article in this site, else 404). 201 ImageUploadResponse. Errors: PAYLOAD_TOO_LARGE,
// UNSUPPORTED_MEDIA (incl. SVG), IMAGE_TOO_LARGE, VALIDATION_FAILED.

export const dynamic = 'force-dynamic';

// Transcribed from spec/api.md until S3.3's dto-phase3.ts lands.
export interface ImageUploadResponse {
  asset: { id: string; key: string; url: string; mimeType: ImageMime; bytes: number; width: number; height: number };
  markdown: string;
}

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

/** Line breaks (and other control characters) would end the snippet early: collapse them to one space. */
function oneLine(text: string): string {
  return text.replace(/[\r\n\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/ {2,}/g, ' ').trim();
}

/**
 * `![alt](/media/<key>)` or `![alt](/media/<key> "caption")`. Alt and caption are single-line;
 * `\`, `[` and `]` in the alt and `\` and `"` in the caption are backslash-escaped so the snippet
 * parses back to exactly the text the writer typed.
 */
export function imageMarkdown(alt: string, url: string, caption?: string): string {
  const safeAlt = oneLine(alt).replace(/[\\[\]]/g, '\\$&');
  const title = caption === undefined ? '' : oneLine(caption);
  if (title !== '') return `![${safeAlt}](${url} "${title.replace(/[\\"]/g, '\\$&')}")`;
  return `![${safeAlt}](${url})`;
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
    const articleId = parsed.data.articleId && parsed.data.articleId !== '' ? parsed.data.articleId : null;
    if (articleId !== null) {
      const found = await findArticle(auth.user.siteId, articleId);
      if (!found) throw new ApiError('NOT_FOUND', 404, 'No such article in this site.');
    }

    const maxBytes = maxImageBytes();
    const site = await getCurrentSite();
    let probedMime: ImageMime | null = null;
    let bytes = 0;
    try {
      const upload = await ingestUpload(body, { field: 'file', maxBytes });
      bytes = upload.buffer.length;
      const probe = probeImage(upload.buffer);
      probedMime = probe.mime;
      const row = await storeMediaAsset({
        siteId: site.id,
        siteSlug: site.slug,
        kind: 'image',
        mime: probe.mime,
        buffer: upload.buffer,
        maxBytes,
        originalFilename: upload.originalFilename,
        createdBy: auth.user.id,
        articleId,
        width: probe.width,
        height: probe.height,
      });
      logMediaUpload({ requestId, kind: 'image', outcome: 'ok', mime: probe.mime, bytes: row.byteSize, width: probe.width, height: probe.height, articleId });
      const url = `/media/${row.storageKey}`;
      const response: ImageUploadResponse = {
        asset: { id: row.id, key: row.storageKey, url, mimeType: probe.mime, bytes: row.byteSize, width: probe.width, height: probe.height },
        markdown: imageMarkdown(alt, url, caption),
      };
      return apiResult(response, { status: 201 });
    } catch (error) {
      if (error instanceof ApiError) {
        logMediaUpload({ requestId, kind: 'image', outcome: 'rejected', mime: probedMime, bytes, articleId, errCode: error.code });
      }
      throw error;
    }
  },
);
