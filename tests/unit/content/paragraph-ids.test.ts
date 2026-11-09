import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { paragraphHash } from '@/server/content';

import { HARD_CASES_MD, render } from './helpers';

describe('paragraphHash', () => {
  it('is p- plus the first 8 hex chars of sha256 of the NFC, whitespace-collapsed, trimmed text', () => {
    const expected = `p-${createHash('sha256').update('Hello world again.').digest('hex').slice(0, 8)}`;

    expect(paragraphHash('  Hello   world\nagain.  ')).toBe(expected);
  });

  it('treats NFC and NFD spellings of the same text as one id', () => {
    const nfc = 'Madhupiṇḍikasutta is a sutta.'.normalize('NFC');
    const nfd = nfc.normalize('NFD');

    expect(nfd).not.toBe(nfc);
    expect(paragraphHash(nfd)).toBe(paragraphHash(nfc));
  });
});

describe('paragraph id stability', () => {
  it('leaves every other id unchanged when one paragraph of hard-cases.md is edited', async () => {
    const before = await render(HARD_CASES_MD);
    const edited = HARD_CASES_MD.replace('Read it before you change anything here.', 'Read it twice before you change anything here.');

    const after = await render(edited);

    const changed = before.paragraphs.find((p) => p.text.includes('Read it before'));
    expect(changed).toBeDefined();
    const beforeIds = before.paragraphs.map((p) => p.pid).filter((pid) => pid !== changed!.pid);
    const afterIds = after.paragraphs.map((p) => p.pid);
    expect(afterIds).toHaveLength(before.paragraphs.length);
    for (const pid of beforeIds) expect(afterIds).toContain(pid);
    expect(afterIds).not.toContain(changed!.pid);
  });

  it('keeps ids when paragraphs are reordered, headings change or new paragraphs are inserted', async () => {
    const before = await render('# A\n\nFirst paragraph text is here.\n\nSecond paragraph text is here.');

    const after = await render('# Renamed\n\nInserted paragraph at the top.\n\nSecond paragraph text is here.\n\n## New\n\nFirst paragraph text is here.');

    const ids = new Map(after.paragraphs.map((p) => [p.text, p.pid]));
    for (const p of before.paragraphs) expect(ids.get(p.text)).toBe(p.pid);
  });

  it('numbers three identical paragraphs -, -2, -3 in document order', async () => {
    const r = await render('Same text again.\n\nSame text again.\n\nSame text again.');

    const base = paragraphHash('Same text again.');
    expect(r.paragraphs.map((p) => p.pid)).toEqual([base, `${base}-2`, `${base}-3`]);
  });

  it('derives the id from plain text, so markup-only edits keep the id', async () => {
    const plain = await render('A careful sentence about software.');
    const marked = await render('A **careful** sentence about [software](https://x.example).');

    expect(marked.paragraphs[0].pid).toBe(plain.paragraphs[0].pid);
  });

  it('gives an image-only paragraph no id and no entry', async () => {
    const r = await render('![alt](/a.png "Caption")\n\nText paragraph with words.');

    expect(r.paragraphs.map((p) => p.text)).toEqual(['Text paragraph with words.']);
  });
});
