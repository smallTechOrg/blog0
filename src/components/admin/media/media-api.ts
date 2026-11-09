// Admin → Media: requests and the small pure formatters (spec/api.md → media).

import type { MediaLibraryItemDto, MediaLibraryResponse, MediaReplaceResponse } from '@/lib/api/dto';

import { apiRequest, type ApiResult } from '../api';
import { uploadMultipart, type UploadOptions } from '../listen/listen-api';

export const MEDIA_PAGE = '/admin/media';

export function listMedia(): Promise<ApiResult<MediaLibraryResponse>> {
  return apiRequest<MediaLibraryResponse>('/api/admin/media');
}

export function replaceMedia(id: string, file: File, opts: UploadOptions = {}): Promise<ApiResult<MediaReplaceResponse>> {
  const form = new FormData();
  form.append('file', file, file.name);
  return uploadMultipart<MediaReplaceResponse>(`/api/admin/media/${encodeURIComponent(id)}/replace`, form, opts);
}

/** "245 KB", "1.4 MB". */
export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const TYPE_LABEL: Record<string, string> = { 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/webp': 'WebP', 'image/gif': 'GIF' };

/** "1200 × 800 · 245 KB · PNG". */
export function detailLine(item: Pick<MediaLibraryItemDto, 'width' | 'height' | 'bytes' | 'mimeType'>): string {
  const parts: string[] = [];
  if (item.width && item.height) parts.push(`${item.width} × ${item.height}`);
  parts.push(fmtBytes(item.bytes));
  parts.push(TYPE_LABEL[item.mimeType] ?? item.mimeType);
  return parts.join(' · ');
}

/** The Markdown that shows the image (alt text is the filename without its extension, for the writer to edit). */
export function markdownFor(item: Pick<MediaLibraryItemDto, 'filename' | 'url'>): string {
  const alt = item.filename.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').replace(/[[\]\\]/g, '').trim();
  return `![${alt}](${item.url})`;
}

/** Items matching a search: filename, address, or the title of an article that uses it. */
export function filterItems(items: readonly MediaLibraryItemDto[], query: string): MediaLibraryItemDto[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  return items.filter(
    (i) => i.filename.toLowerCase().includes(q) || i.key.toLowerCase().includes(q) || i.usedIn.some((u) => u.title.toLowerCase().includes(q)),
  );
}

export function articleHref(articleId: string): string {
  return `/admin/articles/${articleId}`;
}
