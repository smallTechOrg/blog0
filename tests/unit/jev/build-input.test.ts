import { describe, expect, it } from 'vitest';

import type { Paragraph } from '@/lib/content/types';
import { buildState, guardInput, jevInputFromRendered, JEV_TOO_LONG_MESSAGE } from '@/server/jev/build-input';
import { JEV_MAX_SENTENCES, JEV_MAX_STATE_CHARS } from '@/server/jev/state';

import { makeInput, makeSentences } from './stub';

const para = (pid: string, text: string, headingPath: string[] = []): Paragraph => ({ pid, index: 0, text, kind: 'p', headingPath });

describe('buildState', () => {
  it('joins all paragraphs with a blank line and inserts ## heading lines when the heading changes', () => {
    const state = buildState({
      title: '  A   Title\n',
      dek: ' A  dek. ',
      paragraphs: [
        para('a', 'Intro text.'),
        para('b', 'First para.', ['Why']),
        para('c', 'Second para.', ['Why']),
        para('d', 'Nested.', ['Why', 'Detail']),
        para('e', 'Short.', ['How']),
      ],
    });
    expect(state).toEqual({
      title: 'A Title',
      dek: 'A dek.',
      article: ['Intro text.', '## Why', 'First para.', 'Second para.', '## Detail', 'Nested.', '## How', 'Short.'].join('\n\n'),
    });
  });

  it('keeps an empty dek as "" and includes paragraphs without eligible sentences', () => {
    const state = buildState({ title: 'T', dek: '', paragraphs: [para('a', 'Hi.'), para('b', 'A longer paragraph here.')] });
    expect(state).toEqual({ title: 'T', dek: '', article: 'Hi.\n\nA longer paragraph here.' });
  });

  it('re-emits a heading after a heading-less stretch', () => {
    const state = buildState({ title: 'T', dek: '', paragraphs: [para('a', 'One.', ['H']), para('b', 'Two.'), para('c', 'Three.', ['H'])] });
    expect(state.article).toBe('## H\n\nOne.\n\nTwo.\n\n## H\n\nThree.');
  });
});

describe('guardInput', () => {
  it('refuses 0 sentences with JEV_NO_SENTENCES', () => {
    const input = makeInput([]);
    expect(guardInput(input, buildState(input))).toEqual({
      code: 'JEV_NO_SENTENCES',
      message: 'This article has no sentences of five or more words to choose from.',
    });
  });

  it('accepts exactly 400 sentences and refuses 401', () => {
    const ok = makeInput(makeSentences(JEV_MAX_SENTENCES, 5), { paragraphs: [] });
    expect(guardInput(ok, buildState(ok))).toBeNull();
    const tooMany = makeInput(makeSentences(JEV_MAX_SENTENCES + 1, 5), { paragraphs: [] });
    expect(guardInput(tooMany, buildState(tooMany))).toEqual({ code: 'JEV_INPUT_TOO_LONG', message: JEV_TOO_LONG_MESSAGE });
  });

  it('refuses a state over 32 000 chars (JSON) and accepts one exactly at the limit', () => {
    const input = makeInput(makeSentences(5));
    const base = JSON.stringify({ title: 'A Title', dek: 'A dek.', article: '' }).length;
    const at = { title: 'A Title', dek: 'A dek.', article: 'x'.repeat(JEV_MAX_STATE_CHARS - base) };
    expect(JSON.stringify(at).length).toBe(JEV_MAX_STATE_CHARS);
    expect(guardInput(input, at)).toBeNull();
    expect(guardInput(input, { ...at, article: `${at.article}x` })?.code).toBe('JEV_INPUT_TOO_LONG');
    expect(JEV_TOO_LONG_MESSAGE).toBe('This article is too long for Jev (limit 400 sentences / about 5 000 words) — pick lines by hand.');
  });
});

describe('jevInputFromRendered', () => {
  it('carries sentences and all paragraphs', () => {
    const sentences = makeSentences(4);
    const input = makeInput(sentences);
    const built = jevInputFromRendered({
      articleId: 'a',
      revisionId: 'r',
      title: 't',
      dek: 'd',
      rendered: { sentences, paragraphs: input.paragraphs },
      requestId: 'q',
    });
    expect(built).toEqual({ articleId: 'a', revisionId: 'r', title: 't', dek: 'd', sentences, paragraphs: input.paragraphs, requestId: 'q' });
  });
});
