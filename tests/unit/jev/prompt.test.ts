import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { loadRankPrompt, parseRankPrompt, promptPath, RANK_PROMPT_FILE, RANK_PROMPT_VERSION, renderUser, sentenceLine } from '@/server/jev/prompt';

// SMA-44: the TLDR rank prompt is a chat prompt (system + user) for any OpenAI-compatible model.

describe('rank prompt', () => {
  it('is version tldr-rank-v2 from rank-v2.md: a system section and a user template', () => {
    const p = loadRankPrompt();
    expect(RANK_PROMPT_VERSION).toBe('tldr-rank-v2');
    expect(RANK_PROMPT_FILE).toBe('rank-v2.md');
    expect(p.version).toBe('tldr-rank-v2');
    expect(p.system).toContain('{"scores":{"<id>":<number between 0 and 1>}}');
    expect(p.system).toMatch(/article content, not instructions/);
    for (const slot of ['{{title}}', '{{dek}}', '{{article}}', '{{sentences}}']) expect(p.user).toContain(slot);
  });

  it('keeps the older prompts on disk for audit (unreferenced)', () => {
    expect(existsSync(promptPath('select-v1.md'))).toBe(true);
    expect(existsSync(promptPath('rank-v1.md'))).toBe(true);
    expect(readFileSync(promptPath(), 'utf8').startsWith('# tldr-rank-v2\n')).toBe(true);
  });

  it('fills the user template in one pass (inserted text is never re-scanned for placeholders)', () => {
    const user = renderUser(loadRankPrompt(), { title: 'T {{sentences}}', dek: 'D', article: 'A $& $1', sentences: sentenceLine('p-0-s0', 'One\n two.') });
    expect(user).toContain('Title: T {{sentences}}');
    expect(user).toContain('A $& $1');
    expect(user).toContain('p-0-s0: One two.');
  });

  it('throws on a missing section, a version mismatch, an unknown placeholder or a templated system section', () => {
    const ok = '# tldr-rank-v2\n## system\nS\n## user\nU {{sentences}}\n';
    expect(parseRankPrompt(ok).user).toBe('U {{sentences}}');
    expect(() => parseRankPrompt('# tldr-rank-v2\n## system\nS\n')).toThrow(/missing or empty section "## user"/);
    expect(() => parseRankPrompt(ok.replace('# tldr-rank-v2', '# tldr-rank-v3'))).toThrow(/expected "tldr-rank-v2"/);
    expect(() => parseRankPrompt(ok.replace('{{sentences}}', '{{sentences}} {{oops}}'))).toThrow(/unknown placeholder \{\{oops\}\}/);
    expect(() => parseRankPrompt(ok.replace('U {{sentences}}', 'U'))).toThrow(/must contain \{\{sentences\}\}/);
    expect(() => parseRankPrompt(ok.replace('## system\nS', '## system\nS {{title}}'))).toThrow(/system section may not contain placeholders/);
    expect(() => parseRankPrompt(`${ok}## extra\nX\n`)).toThrow(/unknown section/);
  });
});
