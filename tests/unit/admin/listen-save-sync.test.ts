// Listen tab decisions (spec/ui.md §4 Listen tab; spec/capabilities/listen-sync.md → Stale):
// Save sync stays available for a stale draft whose kept marks cover every paragraph (removed
// paragraphs' marks are dropped by that save); the stale banner's action saves the kept marks
// when nothing is missing; "differs from the draft" compares recordings by key; the ← Desk leave
// guard; the audio pre-filter accepts mp3/m4a by extension whatever MIME the browser reports.
import { describe, expect, it } from 'vitest';

import { confirmLeave, LEAVE_EDITOR_CONFIRM } from '@/components/admin/editor/PublishBar';
import { looksLikeAudio } from '@/components/admin/listen/AudioUploader';
import { mediaKeyOf, publishedDiffers, saveSyncState, staleAction, RESYNC_LABEL, SAVE_KEPT_LABEL } from '@/components/admin/listen/save-sync';
import { initialTapState, marksOf, unmarkedCount } from '@/components/admin/listen/useTapSync';
import type { ListenStateDto } from '@/lib/api/dto-phase3';
import { validateMarks } from '@/lib/listen/marks';

const base = { status: 'ready' as const, dirty: false, busy: false, syncing: false, valid: true, hasAudio: true, unmarked: 0 };

describe('saveSyncState', () => {
  it('ready + nothing unsaved → disabled with "Marks are saved"', () => {
    expect(saveSyncState(base)).toEqual({ disabled: true, summary: 'Marks are saved' });
  });

  it('a removed synced paragraph (stale, kept marks cover every paragraph, not dirty) → enabled, no "Marks are saved"', () => {
    // Server marks p1..p4; p4 was removed. The working set drops the orphan, so it equals the
    // server's kept marks (dirty = false) — yet the orphan is only dropped by a save.
    const pids = ['p1', 'p2', 'p3'];
    const server = [
      { pid: 'p1', tMs: 500 },
      { pid: 'p2', tMs: 5000 },
      { pid: 'p3', tMs: 10_500 },
      { pid: 'p4', tMs: 16_000 },
    ];
    const state = initialTapState(pids, server);
    const working = marksOf(state, pids);
    expect(working.map((m) => m.pid)).toEqual(pids);
    const valid = validateMarks(working, pids, 21_000).ok;
    expect(valid).toBe(true);
    const r = saveSyncState({ ...base, status: 'stale', dirty: false, valid, unmarked: unmarkedCount(state) });
    expect(r.disabled).toBe(false);
    expect(r.summary).toBeNull();
  });

  it('stale with an edited paragraph still unmarked → disabled with the count, never "Marks are saved"', () => {
    expect(saveSyncState({ ...base, status: 'stale', valid: false, unmarked: 1 })).toEqual({ disabled: true, summary: '1 paragraph still needs a mark' });
  });

  it('stale but syncing, busy or without audio → disabled', () => {
    expect(saveSyncState({ ...base, status: 'stale', syncing: true }).disabled).toBe(true);
    expect(saveSyncState({ ...base, status: 'stale', busy: true }).disabled).toBe(true);
    const noAudio = saveSyncState({ ...base, status: 'stale', hasAudio: false });
    expect(noAudio).toEqual({ disabled: true, summary: null });
  });

  it('dirty + valid → enabled; dirty + out of order → disabled with the reason', () => {
    expect(saveSyncState({ ...base, status: 'needs_sync', dirty: true })).toEqual({ disabled: false, summary: null });
    expect(saveSyncState({ ...base, dirty: true, valid: false })).toEqual({ disabled: true, summary: 'Some marks are out of order — nudge or redo them' });
    expect(saveSyncState({ ...base, dirty: true, valid: false, unmarked: 3 }).summary).toBe('3 paragraphs still need a mark');
  });
});

describe('staleAction', () => {
  it('redoes from the first missing paragraph', () => {
    expect(staleAction(['p3', 'p2'], ['p1', 'p2', 'p3'])).toEqual({ kind: 'redo', index: 2, label: RESYNC_LABEL });
  });
  it('nothing missing (only removals) → saves the kept marks instead of redoing from paragraph 1', () => {
    expect(staleAction([], ['p1', 'p2'])).toEqual({ kind: 'save', label: SAVE_KEPT_LABEL });
  });
  it('missing pids that are not in the list are skipped', () => {
    expect(staleAction(['gone', 'p2'], ['p1', 'p2'])).toEqual({ kind: 'redo', index: 1, label: RESYNC_LABEL });
    expect(staleAction(['gone'], ['p1'])).toEqual({ kind: 'save', label: SAVE_KEPT_LABEL });
  });
});

describe('publishedDiffers / mediaKeyOf', () => {
  const audio = { key: 'audio/2026/abc.mp3', durationMs: 21_000 } as ListenStateDto['audio'];
  const published = { durationMs: 21_000, markCount: 4, publishedAt: '2026-10-01T00:00:00Z', matchesCurrentText: true };

  it('same key → no difference; another key of the same length → differs', () => {
    expect(publishedDiffers({ audio, published }, 'audio/2026/abc.mp3')).toBe(false);
    expect(publishedDiffers({ audio, published }, 'audio/2026/other.mp3')).toBe(true);
  });
  it('text no longer matches or no draft audio → differs; nothing published → never', () => {
    expect(publishedDiffers({ audio, published: { ...published, matchesCurrentText: false } }, 'audio/2026/abc.mp3')).toBe(true);
    expect(publishedDiffers({ audio: null, published }, undefined)).toBe(true);
    expect(publishedDiffers({ audio, published: null }, 'x')).toBe(false);
  });
  it('key still loading → text decides; key unreadable → the length is the hint', () => {
    expect(publishedDiffers({ audio, published }, undefined)).toBe(false);
    expect(publishedDiffers({ audio, published }, null)).toBe(false);
    expect(publishedDiffers({ audio, published: { ...published, durationMs: 9_000 } }, null)).toBe(true);
  });
  it('mediaKeyOf reads the key from /media/<key> (relative or absolute)', () => {
    expect(mediaKeyOf('/media/audio/2026/abc.mp3')).toBe('audio/2026/abc.mp3');
    expect(mediaKeyOf('https://x.test/media/a%20b.mp3')).toBe('a b.mp3');
    expect(mediaKeyOf('/other/a.mp3')).toBeNull();
    expect(mediaKeyOf('/media/')).toBeNull();
    expect(mediaKeyOf(null)).toBeNull();
  });
});

describe('confirmLeave (← Desk)', () => {
  it('leaves without asking when nothing is unsaved', () => {
    let asked = 0;
    expect(confirmLeave({ dirty: false, marksDirty: false }, () => (asked++, false))).toBe(true);
    expect(asked).toBe(0);
  });
  it('asks when the text or the Listen marks are unsaved, and stays on cancel', () => {
    const seen: string[] = [];
    expect(confirmLeave({ dirty: true }, (m) => (seen.push(m), false))).toBe(false);
    expect(confirmLeave({ dirty: false, marksDirty: true }, (m) => (seen.push(m), false))).toBe(false);
    expect(confirmLeave({ dirty: false, marksDirty: true }, () => true)).toBe(true);
    expect(seen).toEqual([LEAVE_EDITOR_CONFIRM, LEAVE_EDITOR_CONFIRM]);
  });
});

describe('looksLikeAudio', () => {
  it('accepts known audio MIME types', () => {
    for (const type of ['audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/aac']) {
      expect(looksLikeAudio({ type, name: 'reading' })).toBe(true);
    }
  });
  it('accepts .mp3 / .m4a by extension whatever (or no) MIME the browser reports', () => {
    expect(looksLikeAudio({ type: '', name: 'reading.M4A' })).toBe(true);
    expect(looksLikeAudio({ type: 'application/octet-stream', name: 'reading.m4a' })).toBe(true);
    expect(looksLikeAudio({ type: 'video/mp4', name: 'reading.mp3' })).toBe(true);
  });
  it('refuses other files', () => {
    expect(looksLikeAudio({ type: 'text/plain', name: 'notes.txt' })).toBe(false);
    expect(looksLikeAudio({ type: '', name: 'reading.wav' })).toBe(false);
  });
});
