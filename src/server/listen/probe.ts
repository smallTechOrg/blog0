import 'server-only';

import { parseBuffer } from 'music-metadata';

import type { AudioMime } from '@/lib/api/dto';

// Audio probe (spec/architecture.md §9.3): the uploaded bytes decide the type — never the file
// name or the browser's Content-Type. Accepted: MPEG layer III → audio/mpeg (mp3); MPEG-4 audio
// with AAC/ALAC and no video track → audio/mp4 (m4a). Pure over a Buffer; the ingest maps the
// result to HTTP errors.


export interface AudioProbe {
  mimeType: AudioMime;
  /** Whole milliseconds, Math.round(format.duration × 1000). */
  durationMs: number;
  container: string;
  codec: string;
}

export type ProbeResult =
  | { ok: true; probe: AudioProbe }
  | { ok: false; reason: 'unsupported'; detected: string }
  | { ok: false; reason: 'no_duration'; detected: string };

const NOT_AUDIO = 'not an audio file';
const MPEG_CODECS = new Set(['MPEG 1 Layer 3', 'MPEG 2 Layer 3', 'MPEG 2.5 Layer 3']);
const MP4_BRANDS = new Set(['M4A', 'isom', 'mp42', 'iso2', 'M4B']);

/** music-metadata joins the major brand and the compatible brands: "M4A/mp42/isom". */
function brandsOf(container: string): string[] {
  return container.split('/').map((b) => b.trim());
}

function classify(format: { container?: string; codec?: string; hasVideo?: boolean }): AudioMime | null {
  const container = format.container ?? '';
  const codec = format.codec ?? '';
  if (container === 'MPEG' && (MPEG_CODECS.has(codec) || /Layer 3$/.test(codec))) return 'audio/mpeg';
  const isMp4 = brandsOf(container).some((b) => MP4_BRANDS.has(b));
  if (isMp4 && /\b(AAC|ALAC)\b/.test(codec) && format.hasVideo !== true) return 'audio/mp4';
  return null;
}

/** Probes a whole file held in memory. Never throws: a parse failure reads as "not an audio file". */
export async function probeAudio(buf: Buffer | Uint8Array): Promise<ProbeResult> {
  let format: { container?: string; codec?: string; duration?: number; hasVideo?: boolean };
  try {
    const meta = await parseBuffer(buf, undefined, { duration: true, skipCovers: true });
    format = meta.format;
  } catch {
    return { ok: false, reason: 'unsupported', detected: NOT_AUDIO };
  }
  const container = (format.container ?? '').trim();
  const mimeType = classify(format);
  if (mimeType === null) {
    const detected = container === '' ? NOT_AUDIO : format.hasVideo === true ? `${container} video` : `${container} audio`;
    return { ok: false, reason: 'unsupported', detected };
  }
  const duration = format.duration;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
    return { ok: false, reason: 'no_duration', detected: `${container} audio` };
  }
  return {
    ok: true,
    probe: { mimeType, durationMs: Math.round(duration * 1000), container, codec: format.codec ?? '' },
  };
}
