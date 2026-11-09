import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { computeStats, countWords, normalizeText } from '@/server/content';

import { HARD_CASES_MD, render } from './helpers';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('fingerprints', () => {
  it('hashes paragraphs as pid\\0text lines and sentences as sid\\0text lines', async () => {
    const r = await render(HARD_CASES_MD);

    expect(r.fingerprints.paragraphs).toBe(sha(r.paragraphs.map((p) => `${p.pid}\u0000${p.text}`).join('\n')));
    expect(r.fingerprints.sentences).toBe(sha(r.sentences.map((s) => `${s.sid}\u0000${s.text}`).join('\n')));
  });

  it('changes only the body fingerprint when only the title, dek or a heading changes', async () => {
    const md = '# Head\n\nA paragraph with enough words in it.';
    const base = await render(md, 'Title', 'Dek');

    for (const variant of [await render(md, 'Other title', 'Dek'), await render(md, 'Title', 'Other dek'), await render(md.replace('Head', 'Other head'))]) {
      expect(variant.fingerprints.body).not.toBe(base.fingerprints.body);
      expect(variant.fingerprints.paragraphs).toBe(base.fingerprints.paragraphs);
      expect(variant.fingerprints.sentences).toBe(base.fingerprints.sentences);
    }
  });

  it('changes paragraphs but not sentences when only a short (ineligible) paragraph changes', async () => {
    const a = await render('A paragraph with enough words in it.\n\nTiny one.');
    const b = await render('A paragraph with enough words in it.\n\nTiny two.');

    expect(b.fingerprints.paragraphs).not.toBe(a.fingerprints.paragraphs);
    expect(b.fingerprints.sentences).toBe(a.fingerprints.sentences);
  });

  it('changes the sentences fingerprint when an eligible sentence changes', async () => {
    const a = await render('A paragraph with enough words in it.');
    const b = await render('A paragraph with enough new words in it.');

    expect(b.fingerprints.sentences).not.toBe(a.fingerprints.sentences);
  });

  it('ignores trailing whitespace and NFC/NFD differences in the body fingerprint but not structural newlines', async () => {
    const base = await render('- one item here\n- two item here');

    expect((await render('- one item here   \n- two item here\n\n')).fingerprints.body).toBe(base.fingerprints.body);
    expect((await render('- one item here\r\n- two item here')).fingerprints.body).toBe(base.fingerprints.body);
    expect((await render('- one item here - two item here')).fingerprints.body).not.toBe(base.fingerprints.body);
    const nfc = await render('Madhupiṇḍikasutta text here.'.normalize('NFC'));
    expect((await render('Madhupiṇḍikasutta text here.'.normalize('NFD'))).fingerprints.body).toBe(nfc.fingerprints.body);
  });

  it('normalizeText applies NFC, collapses whitespace and trims', () => {
    expect(normalizeText('  a\t b\n\nc  ')).toBe('a b c');
  });
});

describe('stats', () => {
  it('counts whitespace-separated words', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('  one  two\nthree ')).toBe(3);
  });

  it.each([
    [0, 1],
    [1, 1],
    [230, 1],
    [231, 2],
    [460, 2],
    [461, 3],
  ])('rounds %i words up to %i read minutes (min 1)', (words, minutes) => {
    const text = Array.from({ length: words }, () => 'w').join(' ');

    expect(computeStats([{ pid: 'p-00000000', index: 0, text, kind: 'p', headingPath: [] }])).toEqual({ words, readMinutes: minutes });
  });
});
