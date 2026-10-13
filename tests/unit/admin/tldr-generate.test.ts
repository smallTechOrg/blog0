import { describe, expect, it } from 'vitest';

import { generateButtonLabel, generatedNotice, runExclusive } from '@/components/admin/editor/tldr-generate';

const BASE = { elapsed: 0, editorDirty: false, hasDraft: false, latestSucceeded: false };

describe('generateButtonLabel', () => {
  it('shows the idle labels per spec/ui.md §4', () => {
    expect(generateButtonLabel({ ...BASE, phase: 'idle' })).toBe('Generate with Jev');
    expect(generateButtonLabel({ ...BASE, phase: 'idle', hasDraft: true })).toBe('Regenerate');
    expect(generateButtonLabel({ ...BASE, phase: 'idle', latestSucceeded: true })).toBe('Regenerate');
    expect(generateButtonLabel({ ...BASE, phase: 'idle', editorDirty: true, hasDraft: true })).toBe('Save & generate');
  });

  it('shows a busy label while the editor pre-save runs, then the Jev timer', () => {
    expect(generateButtonLabel({ ...BASE, phase: 'saving', editorDirty: true })).toBe('Saving…');
    expect(generateButtonLabel({ ...BASE, phase: 'running', elapsed: 7, editorDirty: true })).toBe('Jev is ranking… 7s');
  });
});

describe('generatedNotice', () => {
  it('says how many sentences Jev ranked and that the top lines are already the draft deck (no "then Save deck")', () => {
    const text = generatedNotice(42, 6);
    expect(text).toBe('Jev ranked 42 sentences and picked the top 6 — saved as your draft deck. Edit them or publish.');
    expect(text).not.toMatch(/Save deck/);
  });

  it('uses the singular for one sentence and one line', () => {
    expect(generatedNotice(1, 1)).toBe('Jev ranked 1 sentence and picked the top line — saved as your draft deck. Edit them or publish.');
  });
});

describe('runExclusive', () => {
  it('ignores a second call while the first is in flight (double-click on Save & generate)', async () => {
    const flight = { current: false };
    let calls = 0;
    let release!: () => void;
    const run = () =>
      new Promise<string>((resolve) => {
        calls += 1;
        release = () => resolve('done');
      });

    const first = runExclusive(flight, run);
    const second = runExclusive(flight, run); // same tick: before any re-render could disable the button
    expect(flight.current).toBe(true);
    expect(await second).toBeUndefined();
    expect(calls).toBe(1);

    release();
    expect(await first).toBe('done');
    expect(flight.current).toBe(false);
  });

  it('releases the guard when the run throws, so the writer can try again', async () => {
    const flight = { current: false };
    await expect(runExclusive(flight, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(flight.current).toBe(false);
    expect(await runExclusive(flight, () => Promise.resolve(2))).toBe(2);
  });
});
