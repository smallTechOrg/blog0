import 'server-only';

import { FORMAT_KINDS, type FormatKind } from '@/lib/formats/registry';

import { listenAdapter } from './listen';
import { readAdapter } from './read';
import { tldrAdapter } from './tldr';
import type { FormatAdapter } from './types';

// Server-side format registry, keyed by src/lib/formats/registry.ts (registry order).

export const FORMAT_ADAPTERS: Record<FormatKind, FormatAdapter> = {
  read: readAdapter,
  tldr: tldrAdapter,
  listen: listenAdapter,
};

export function getFormatAdapter(kind: FormatKind): FormatAdapter {
  return FORMAT_ADAPTERS[kind];
}

/** Every registered adapter in FORMAT_KINDS order. */
export function formatAdapters(): FormatAdapter[] {
  return FORMAT_KINDS.map((kind) => FORMAT_ADAPTERS[kind]);
}

export type { FormatAdapter, PublishCheck, StatusContext, ChipContext } from './types';
export { GENERATION_STALE_MS, isGenerationActive } from './types';
export { missingSlides } from './tldr';
export { readTldrPayload, tldrPayloadSchema, TLDR_MAX_SLIDES, TLDR_MIN_SLIDES, TLDR_REASON_MAX, type TldrPayload, type TldrSlide } from './payload';
