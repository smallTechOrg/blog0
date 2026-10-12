import 'server-only';

import { FORMAT_KINDS, type FormatKind } from '@/lib/formats/registry';

import { listenAdapter } from './listen';
import { readAdapter } from './read';
import { tldrAdapter } from './tldr';
import type { FormatAdapter } from './types';

// Server-side format registry, keyed by src/lib/formats/registry.ts (registry order).

const FORMAT_ADAPTERS: Record<FormatKind, FormatAdapter> = {
  read: readAdapter,
  tldr: tldrAdapter,
  listen: listenAdapter,
};

/** Every registered adapter in FORMAT_KINDS order. */
export function formatAdapters(): FormatAdapter[] {
  return FORMAT_KINDS.map((kind) => FORMAT_ADAPTERS[kind]);
}
