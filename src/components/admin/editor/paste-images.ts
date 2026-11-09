// Pasted Markdown that carries its images inline (spec/capabilities/media-images.md → "Pasted
// Markdown"). Tools such as Google Docs and Notion export each picture as a `data:image/…;base64,…`
// URL, either inside the image (`![alt](data:…)`) or in a reference definition at the end
// (`![alt][image1]` … `[image1]: <data:…>`). The page never shows a data URL, so the editor uploads
// each one and swaps it for its `/media/<key>` address. Pure: no network, no DOM except `File`.

import { ACCEPTED_IMAGE_TYPES, ALT_MAX } from './insert-image';

const DATA_URI = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]+={0,2}/gi;

const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

export interface EmbeddedImage {
  /** The whole data URL exactly as pasted. */
  uri: string;
  /** Lower-case `image/…` type from the URL. */
  mime: string;
  /** The alt text it had in the Markdown (cleaned, ≤ 200 chars); '' when none. */
  alt: string;
}

export interface EmbeddedImages {
  /** Uploadable images (PNG, JPEG, WebP, GIF), each distinct URL once, in order of appearance. */
  images: EmbeddedImage[];
  /** Embedded images in a format the library refuses (SVG, BMP, …): left as they are. */
  unsupported: number;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanAlt(raw: string): string {
  return raw.replace(/\\([\\[\]])/g, '$1').replace(/\s+/g, ' ').trim().slice(0, ALT_MAX);
}

/** How far before a data URL to look for the `![alt](` or `[id]:` that introduces it. */
const LEAD = 600;

/**
 * The alt text of the image that uses `uri`: inline `![alt](uri)`, else through its `[id]: uri`
 * definition. The URL itself is never put in a pattern (a real photo's data URL is far larger than
 * a regular expression may be); only the short text just before it is matched.
 */
function altOf(text: string, uri: string): string {
  const at = text.indexOf(uri);
  if (at < 0) return '';
  const head = text.slice(Math.max(0, at - LEAD), at);
  const inline = /!\[((?:[^\]\\]|\\.)*)\]\(\s*<?$/.exec(head);
  if (inline) return cleanAlt(inline[1]);
  const def = /(?:^|\n)[ \t]{0,3}\[([^\]]+)\]:\s*<?$/.exec(head);
  if (def) {
    const ref = new RegExp(`!\\[((?:[^\\]\\\\]|\\\\.)*)\\]\\[${escapeRe(def[1])}\\]`, 'i').exec(text);
    if (ref) return cleanAlt(ref[1]);
  }
  return '';
}

/** Every embedded image in `text`. */
export function findEmbeddedImages(text: string): EmbeddedImages {
  const images: EmbeddedImage[] = [];
  const seen = new Set<string>();
  let unsupported = 0;
  if (!text.includes('data:image/')) return { images, unsupported };
  for (const match of text.matchAll(DATA_URI)) {
    const uri = match[0];
    if (seen.has(uri)) continue;
    seen.add(uri);
    const mime = /^data:(image\/[a-z0-9.+-]+);/i.exec(uri)![1].toLowerCase();
    if (!(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(mime)) {
      unsupported += 1;
      continue;
    }
    images.push({ uri, mime, alt: altOf(text, uri) });
  }
  return { images, unsupported };
}

/** `text` with every data URL in `urls` replaced by its address (all occurrences). */
export function replaceEmbeddedImages(text: string, urls: ReadonlyMap<string, string>): string {
  let out = text;
  for (const [uri, url] of urls) out = out.split(uri).join(url);
  return out;
}

/** The decoded image as a `File` named `pasted-image-<n>.<ext>` (null when the base64 is not decodable). */
export function fileFromDataUri(image: EmbeddedImage, n: number): File | null {
  try {
    const binary = atob(image.uri.slice(image.uri.indexOf(',') + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    if (bytes.length === 0) return null;
    return new File([bytes], `pasted-image-${n}.${EXTENSIONS[image.mime] ?? 'png'}`, { type: image.mime });
  } catch {
    return null;
  }
}
