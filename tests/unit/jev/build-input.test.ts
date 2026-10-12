import { describe, expect, it } from 'vitest';

import {
  buildMessages,
  buildUserMessage,
  guardInput,
  jevInputFromRendered,
  repairMessages,
} from '@/server/jev/build-input';
import { computeBounds } from '@/server/jev/bounds';
import { JEV_PROMPT_VERSION, loadPrompt, loadPromptTemplate, renderPrompt } from '@/server/jev/prompt';

import { makeInput, makeSentences } from './stub';

describe('Jev prompt', () => {
  it('is version jev-select-v1 and fills {{site_name}}', () => {
    const prompt = loadPrompt({ siteName: 'blog0' });

    expect(JEV_PROMPT_VERSION).toBe('jev-select-v1');
    expect(prompt.version).toBe('jev-select-v1');
    expect(prompt.text).toContain('You are Jev, the TLDR editor for blog0. You choose — you never write.');
    expect(prompt.text).not.toMatch(/\{\{/);
    expect(prompt.text).toContain('{"picks":[{"index":<int>,"reason":"<text>"}]}');
    expect(prompt.text).toContain('<<<SENTENCES');
  });

  it('keeps the template placeholder in the raw file', () => {
    expect(loadPromptTemplate()).toContain('{{site_name}}');
  });

  it('refuses to render a template with an unknown placeholder', () => {
    expect(() => renderPrompt('Hi {{site_name}} {{author}}', { siteName: 'x' })).toThrow(/unfilled placeholder \{\{author\}\}/);
  });
});

describe('buildMessages', () => {
  it('builds a system prompt plus the fenced, numbered sentence list with sections and bounds', () => {
    const input = makeInput(makeSentences(6));
    const bounds = computeBounds(input.sentences);

    const messages = buildMessages(input, bounds, { siteName: 'blog0' });

    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    const user = messages[1].content.split('\n');
    expect(user.slice(0, 5)).toEqual([
      'TITLE: A Title',
      'DEK: A dek.',
      'PICK BETWEEN 4 AND 5 SENTENCES (aim for 4).',
      'SENTENCES (index · section · text):',
      '<<<SENTENCES',
    ]);
    expect(user[5]).toBe(`[0] · (intro) · ${input.sentences[0].text}`);
    expect(user[7]).toBe(`[2] · Section One · ${input.sentences[2].text}`);
    expect(user[9]).toBe(`[4] · Section One › Sub · ${input.sentences[4].text}`);
    expect(user.at(-1)).toBe('SENTENCES>>>');
  });

  it('writes (none) for an empty dek', () => {
    const input = makeInput(makeSentences(4), { dek: '  ' });

    expect(buildUserMessage(input, computeBounds(input.sentences))).toContain('DEK: (none)');
  });
});

describe('guardInput', () => {
  it('refuses zero sentences with JEV_NO_SENTENCES', () => {
    const input = makeInput([]);

    expect(guardInput(input, computeBounds([]))).toEqual({
      code: 'JEV_NO_SENTENCES',
      message: 'This article has no sentences of five or more words to choose from.',
    });
  });

  it('refuses more than 400 sentences with JEV_INPUT_TOO_LONG', () => {
    const input = makeInput(makeSentences(401, 5));

    expect(guardInput(input, computeBounds(input.sentences))?.code).toBe('JEV_INPUT_TOO_LONG');
  });

  it('refuses a sentence list over 60 000 characters', () => {
    const input = makeInput(makeSentences(100, 120));

    expect(guardInput(input, computeBounds(input.sentences))?.code).toBe('JEV_INPUT_TOO_LONG');
  });

  it('accepts exactly 400 short sentences', () => {
    const input = makeInput(makeSentences(400, 5));

    expect(guardInput(input, computeBounds(input.sentences))).toBeNull();
  });
});

describe('repairMessages', () => {
  it('appends the raw output and the spec repair instruction', () => {
    const input = makeInput(makeSentences(10));
    const bounds = { min: 4, max: 6, target: 5 };
    const messages = buildMessages(input, bounds, { siteName: 'blog0' });

    const next = repairMessages({ messages, bounds, input }, '{"picks":[]}', ['a', 'b']);

    expect(next).toHaveLength(4);
    expect(next[2]).toEqual({ role: 'assistant', content: '{"picks":[]}' });
    expect(next[3]).toEqual({
      role: 'user',
      content:
        'Your previous answer was invalid: a; b. Return only corrected JSON that follows the schema, choosing between 4 and 6 indices from 0 to 9.',
    });
  });
});

describe('jevInputFromRendered', () => {
  it('maps paragraph heading paths by pid', () => {
    const sentences = makeSentences(2);

    const input = jevInputFromRendered({
      articleId: 'a',
      revisionId: 'r',
      title: 't',
      dek: 'd',
      requestId: 'q',
      rendered: { sentences, paragraphs: [{ pid: 'p-0', index: 0, text: 'x', kind: 'p', headingPath: ['H'] }] },
    });

    expect(input.headingPathByPid).toEqual({ 'p-0': ['H'] });
    expect(input.sentences).toBe(sentences);
  });
});
