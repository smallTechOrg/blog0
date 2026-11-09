import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { JEV_PROMPT_FILE, JEV_PROMPT_VERSION, loadRankPrompt, parseRankPrompt, promptPath, renderInstructions } from '@/server/jev/prompt';

describe('rank prompt', () => {
  it('is version jev-rank-v1 from rank-v1.md with the three sections', () => {
    const p = loadRankPrompt();
    expect(JEV_PROMPT_VERSION).toBe('jev-rank-v1');
    expect(JEV_PROMPT_FILE).toBe('rank-v1.md');
    expect(p).toEqual({
      version: 'jev-rank-v1',
      instructions:
        "Is this sentence one of the few most important lines a reader must see to grasp the article's core argument in a 1-minute summary? Sentence: {{sentence}}",
      criteriaTrue: 'It states a central claim, key evidence, or the conclusion of the article.',
      criteriaFalse: 'It is supporting detail, an aside, an example, a transition, or repetition.',
    });
  });

  it('keeps the chat-era select-v1.md on disk for audit (unreferenced)', () => {
    expect(existsSync(promptPath('select-v1.md'))).toBe(true);
    expect(readFileSync(promptPath(), 'utf8').startsWith('# jev-rank-v1\n')).toBe(true);
  });

  it('fills {{sentence}} with JSON.stringify(text)', () => {
    expect(renderInstructions(loadRankPrompt(), 'It "works".')).toMatch(/Sentence: "It \\"works\\"\."$/);
  });

  it('throws on a missing section, a version mismatch, or an unknown placeholder', () => {
    const ok = '# jev-rank-v1\n## instructions\nQ {{sentence}}\n## true\nT\n## false\nF\n';
    expect(parseRankPrompt(ok).criteriaFalse).toBe('F');
    expect(() => parseRankPrompt('# jev-rank-v1\n## instructions\nQ {{sentence}}\n## true\nT\n')).toThrow(/missing or empty section "## false"/);
    expect(() => parseRankPrompt(ok.replace('# jev-rank-v1', '# jev-rank-v2'))).toThrow(/expected "jev-rank-v1"/);
    expect(() => parseRankPrompt(ok.replace('{{sentence}}', '{{sentence}} {{title}}'))).toThrow(/unknown placeholder \{\{title\}\}/);
    expect(() => parseRankPrompt(ok.replace('Q {{sentence}}', 'Q'))).toThrow(/must contain \{\{sentence\}\}/);
    expect(() => parseRankPrompt(`${ok}## extra\nX\n`)).toThrow(/unknown section/);
  });
});
