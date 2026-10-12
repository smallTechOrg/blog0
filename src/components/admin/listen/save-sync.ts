// Pure decisions behind the Listen tab's footer and stale banner (spec/ui.md §4 Listen tab;
// spec/capabilities/listen-sync.md → Stale). Kept out of the component so they are unit-tested.

import type { ListenStateDto, ListenStatus } from '@/lib/api/dto-phase3';

export interface SaveSyncInput {
  status: ListenStatus;
  /** Working marks differ from the server's (orphans already dropped from both sides). */
  dirty: boolean;
  busy: boolean;
  syncing: boolean;
  /** `validateMarks` passed for the working set. */
  valid: boolean;
  hasAudio: boolean;
  /** Paragraphs without a mark in the working set. */
  unmarked: number;
}

export interface SaveSyncState {
  disabled: boolean;
  /** Why Save sync is disabled (shown only while it is), or null. */
  summary: string | null;
}

/**
 * Save sync is enabled when every paragraph has a valid mark and there is something to save:
 * unsaved marks, or a `stale` draft — its orphan marks (paragraphs that were removed) are only
 * dropped by the next save, so a stale draft whose kept marks already cover every paragraph must
 * stay saveable even though nothing differs locally.
 */
export function saveSyncState(i: SaveSyncInput): SaveSyncState {
  const saveable = i.dirty || i.status === 'stale';
  const disabled = i.busy || i.syncing || !saveable || !i.valid || !i.hasAudio;
  let summary: string | null = null;
  if (i.hasAudio) {
    if (i.unmarked > 0) summary = `${i.unmarked} ${i.unmarked === 1 ? 'paragraph still needs' : 'paragraphs still need'} a mark`;
    else if (!i.valid) summary = 'Some marks are out of order — nudge or redo them';
    else if (!saveable) summary = 'Marks are saved';
  }
  return { disabled, summary: disabled ? summary : null };
}

export type StaleAction = { kind: 'redo'; index: number; label: string } | { kind: 'save'; label: string };

export const RESYNC_LABEL = 'Re-sync from the first change';
export const SAVE_KEPT_LABEL = 'Save kept marks';

/**
 * The stale banner's primary action: Redo from here on the first `missingPids` entry; when no
 * paragraph is missing (only removals), there is nothing to re-tap — the action saves the kept
 * marks, which drops the orphans and makes Listen `ready`.
 */
export function staleAction(missingPids: readonly string[], pids: readonly string[]): StaleAction {
  for (const pid of missingPids) {
    const index = pids.indexOf(pid);
    if (index >= 0) return { kind: 'redo', index, label: RESYNC_LABEL };
  }
  return { kind: 'save', label: SAVE_KEPT_LABEL };
}

/** `/media/<key>` → `<key>` (null when the URL is not a media URL). */
export function mediaKeyOf(url: string | null | undefined): string | null {
  if (!url) return null;
  let path = url;
  try {
    path = new URL(url, 'http://local.invalid').pathname;
  } catch {
    return null;
  }
  return path.startsWith('/media/') && path.length > '/media/'.length ? decodeURIComponent(path.slice('/media/'.length)) : null;
}

/**
 * "· differs from the draft": the published Listen no longer matches the current text, or the
 * draft recording is not the published one. The recording is compared by storage key (unique
 * per upload). `publishedKey`: undefined while still loading (only the text decides); null when
 * the published key can't be read (article not public) — then the recording length is the hint.
 */
export function publishedDiffers(listen: Pick<ListenStateDto, 'audio' | 'published'>, publishedKey: string | null | undefined): boolean {
  if (!listen.published) return false;
  if (!listen.published.matchesCurrentText) return true;
  if (!listen.audio) return true;
  if (publishedKey === undefined) return false;
  if (publishedKey === null) return listen.audio.durationMs !== listen.published.durationMs;
  return listen.audio.key !== publishedKey;
}
