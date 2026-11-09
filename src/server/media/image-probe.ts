import { imageSize } from 'image-size';

import type { ImageMime } from '@/lib/api/dto';

import { ApiError } from '../http/api';

// Image probe (spec/architecture.md §9.3): type + dimensions from the bytes via `image-size`.
// png/jpg/webp/gif → mime; anything else (incl. svg, bmp, tiff, avif, ico) or a throw → 415
// UNSUPPORTED_MEDIA; width or height > 12 000 → 422 IMAGE_TOO_LARGE. Extension and the
// browser's Content-Type are ignored: content wins.

export interface ImageProbe {
  mime: ImageMime;
  width: number;
  height: number;
}

export const MAX_IMAGE_DIMENSION = 12_000;

const MIME_BY_TYPE: Record<string, ImageMime> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

const TYPE_LABELS: Record<string, string> = {
  svg: 'an SVG',
  bmp: 'a BMP',
  tiff: 'a TIFF',
  avif: 'an AVIF',
  heif: 'a HEIF',
  ico: 'an ICO',
  cur: 'a CUR',
  psd: 'a Photoshop file',
  dds: 'a DDS',
  icns: 'an ICNS',
  j2c: 'a JPEG 2000',
  jp2: 'a JPEG 2000',
  jxl: 'a JPEG XL',
  ktx: 'a KTX',
  pnm: 'a PNM',
  tga: 'a TGA',
};

export function probeImage(buf: Buffer): ImageProbe {
  let probed: { type?: string; width?: number; height?: number };
  try {
    probed = imageSize(buf);
  } catch {
    throw new ApiError('UNSUPPORTED_MEDIA', 415, 'That file is not an image we can read; upload a PNG, JPEG, WebP or GIF.');
  }
  const type = probed.type ?? '';
  const mime = MIME_BY_TYPE[type];
  if (!mime) {
    const label = TYPE_LABELS[type] ?? (type ? `a ${type.toUpperCase()} image` : 'not a recognised image');
    throw new ApiError('UNSUPPORTED_MEDIA', 415, `That file is ${label}; upload a PNG, JPEG, WebP or GIF.`, { detected: type || null });
  }
  const width = probed.width ?? 0;
  const height = probed.height ?? 0;
  if (!(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0)) {
    throw new ApiError('UNSUPPORTED_MEDIA', 415, "Couldn't read the image's dimensions; upload a PNG, JPEG, WebP or GIF.", { detected: type });
  }
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    throw new ApiError(
      'IMAGE_TOO_LARGE',
      422,
      `That image is ${width}×${height} px; the longest side must be at most ${MAX_IMAGE_DIMENSION} px.`,
      { width, height, max: MAX_IMAGE_DIMENSION },
    );
  }
  return { mime, width, height };
}
