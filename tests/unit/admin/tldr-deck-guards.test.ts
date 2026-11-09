// TldrTab's Save deck / Clear deck are single-flight (qa finding): each runs through runExclusive
// with its OWN ref, set synchronously on click, so a double-click can't send a second PUT/DELETE
// before React re-renders the disabled button — and one action in flight doesn't block the other's guard.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { runExclusive } from '@/components/admin/editor/tldr-generate';

const SOURCE = readFileSync(path.join(import.meta.dirname, '../../../src/components/admin/editor/TldrTab.tsx'), 'utf8');

function deferred() {
  let release!: () => void;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { done, release };
}

describe('TldrTab deck action guards', () => {
  it('wires Save deck and Clear deck through runExclusive with their own refs', () => {
    expect(SOURCE).toMatch(/const savingDeck = useRef\(false\)/);
    expect(SOURCE).toMatch(/const clearingDeck = useRef\(false\)/);
    expect(SOURCE).toMatch(/function saveDeck\(\)[^{]*\{\s*return runExclusive\(savingDeck, runSaveDeck\)/);
    expect(SOURCE).toMatch(/function clearDeck\(\)[^{]*\{\s*return runExclusive\(clearingDeck, runClearDeck\)/);
    expect(SOURCE).toMatch(/onClick=\{\(\) => void saveDeck\(\)\}/);
    expect(SOURCE).toMatch(/onClick=\{\(\) => void clearDeck\(\)\}/);
  });

  it('a double-click on Save deck sends one request', async () => {
    const savingDeck = { current: false };
    const gate = deferred();
    let puts = 0;
    const runSaveDeck = async () => {
      puts += 1;
      await gate.done;
    };

    const first = runExclusive(savingDeck, runSaveDeck);
    const second = runExclusive(savingDeck, runSaveDeck);
    expect(await second).toBeUndefined();
    expect(puts).toBe(1);

    gate.release();
    await first;
    expect(savingDeck.current).toBe(false);
    await runExclusive(savingDeck, runSaveDeck); // re-enabled after the first settles
    expect(puts).toBe(2);
  });

  it('releases the Clear deck guard when the request fails, so the writer can retry', async () => {
    const clearingDeck = { current: false };
    await expect(
      runExclusive(clearingDeck, async () => {
        throw new Error('network');
      }),
    ).rejects.toThrow('network');
    expect(clearingDeck.current).toBe(false);
  });

  it('keeps separate guards: a Save in flight does not swallow a Clear, and vice versa', async () => {
    const savingDeck = { current: false };
    const clearingDeck = { current: false };
    const gate = deferred();
    const calls: string[] = [];

    const save = runExclusive(savingDeck, async () => {
      calls.push('save');
      await gate.done;
    });
    await runExclusive(clearingDeck, async () => {
      calls.push('clear');
    });
    gate.release();
    await save;

    expect(calls).toEqual(['save', 'clear']);
  });
});
