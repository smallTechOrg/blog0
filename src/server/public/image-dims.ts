import 'server-only';

import { and, eq, inArray, isNotNull } from 'drizzle-orm';

import { walk, type MdNode } from '../content/ast';
import { parseMarkdown } from '../content/markdown';
import { getDb } from '../db/client';
import { mediaAsset } from '../db/schema';

// Inline image dimensions for the published page (Stage A — spec/architecture.md §4 "Image
// dimensions"): a pre-render lookup so `renderArticle` stays pure. `mediaImageSrcs` lists the body's
// `/media/` image srcs; `loadImageDims` reads their width/height from `media_asset` in one query;
// the map (keyed by the src exactly as written) goes into renderArticle({ …, imageDims }).

export const MEDIA_PREFIX = '/media/';

export type ImageDims = ReadonlyMap<string, { width: number; height: number }>;

type RefNode = MdNode & { identifier?: string };

/** The `/media/` srcs of every image in the Markdown body (inline and reference-style), once each, in document order. */
export function mediaImageSrcs(bodyMd: string): string[] {
  if (!bodyMd || !bodyMd.includes(MEDIA_PREFIX)) return [];
  const root = parseMarkdown(bodyMd.replace(/\r\n?/g, '\n'));
  const definitions = new Map<string, string>();
  walk<MdNode>(root, (node) => {
    const n = node as RefNode;
    if (n.type === 'definition' && n.identifier && typeof n.url === 'string' && !definitions.has(n.identifier)) {
      definitions.set(n.identifier, n.url);
    }
  });
  const out: string[] = [];
  const seen = new Set<string>();
  walk<MdNode>(root, (node) => {
    const n = node as RefNode;
    const url = n.type === 'image' ? n.url : n.type === 'imageReference' && n.identifier ? definitions.get(n.identifier) : undefined;
    if (typeof url === 'string' && url.startsWith(MEDIA_PREFIX) && url.length > MEDIA_PREFIX.length && !seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  });
  return out;
}

/** The storage key a `/media/<key>` src names, or null for a src with a query or fragment. */
function storageKeyOf(src: string): string | null {
  if (!src.startsWith(MEDIA_PREFIX) || /[?#]/.test(src)) return null;
  const key = src.slice(MEDIA_PREFIX.length);
  return key || null;
}

/** width/height of the site's image assets behind `srcs` (one query; unknown keys and assets without dimensions are left out). */
export async function loadImageDims(siteId: string, srcs: readonly string[]): Promise<Map<string, { width: number; height: number }>> {
  const byKey = new Map<string, string>();
  for (const src of srcs) {
    const key = storageKeyOf(src);
    if (key) byKey.set(key, src);
  }
  const dims = new Map<string, { width: number; height: number }>();
  if (byKey.size === 0) return dims;
  const rows = await getDb()
    .select({ storageKey: mediaAsset.storageKey, width: mediaAsset.width, height: mediaAsset.height })
    .from(mediaAsset)
    .where(
      and(
        eq(mediaAsset.siteId, siteId),
        eq(mediaAsset.kind, 'image'),
        inArray(mediaAsset.storageKey, [...byKey.keys()]),
        isNotNull(mediaAsset.width),
        isNotNull(mediaAsset.height),
      ),
    );
  for (const r of rows) {
    const src = byKey.get(r.storageKey);
    if (src && r.width && r.height && r.width > 0 && r.height > 0) dims.set(src, { width: r.width, height: r.height });
  }
  return dims;
}
