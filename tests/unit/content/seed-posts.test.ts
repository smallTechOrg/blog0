import { describe, expect, it } from 'vitest';

import { loadSeedPosts } from '@/server/seed/posts';

import { html, render } from './helpers';

const posts = loadSeedPosts();

describe('the five seed posts', () => {
  it('are five', () => {
    expect(posts).toHaveLength(5);
  });

  it.each(posts.map((p) => [p.slug, p] as const))('%s renders cleanly with verbatim eligible sentences', async (_slug, post) => {
    const r = await render(post.bodyMd, post.title, post.dek);
    const out = html(r.blocks);

    expect(r.warnings).toEqual([]);
    expect(r.blocks.length).toBeGreaterThan(0);
    expect(r.paragraphs.length).toBeGreaterThan(0);
    expect(r.sentences.length).toBeGreaterThanOrEqual(4);
    expect(r.stats.words).toBeGreaterThan(50);
    for (const s of r.sentences) {
      const p = r.paragraphs.find((x) => x.pid === s.pid)!;
      expect(p.text).toContain(s.text);
      expect(s.text).not.toMatch(/\*\*|\]\(|^\s|\s$/);
      expect(s.words).toBeGreaterThanOrEqual(5);
    }
    for (const p of r.paragraphs) expect(out).toContain(`data-pid="${p.pid}"`);
    expect(out).not.toContain('@@fig');
    expect(new Set(r.paragraphs.map((p) => p.pid)).size).toBe(r.paragraphs.length);
    expect(await render(post.bodyMd, post.title, post.dek)).toEqual(r);
  });

  it('renders tech-company-first with both known figures between prose blocks', async () => {
    const post = posts.find((p) => p.slug === 'tech-company-first')!;

    const r = await render(post.bodyMd, post.title, post.dek);

    expect(r.blocks.map((b) => (b.kind === 'figure' ? `${b.figureId}:${b.known}` : 'html'))).toEqual([
      'html',
      'slide47:true',
      'html',
      'ab-companies:true',
      'html',
    ]);
    expect(r.sentences.map((s) => s.text)).toEqual(expect.arrayContaining([
      'Humans are creatures of convenience.',
      'Even the smallest barrier to act discourages us.',
    ]));
    expect(html(r.blocks)).toContain('<a href="https://smalltech.in/" class="inline" target="_blank" rel="noopener noreferrer">smallTech</a>');
  });
});
