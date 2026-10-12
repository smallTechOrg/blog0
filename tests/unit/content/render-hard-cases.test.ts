import { beforeAll, describe, expect, it } from 'vitest';

import type { RenderedArticle } from '@/lib/content/types';
import { paragraphHash } from '@/server/content';

import { HARD_CASES_MD, html, render, sentenceTexts } from './helpers';

// spec/capabilities/article-authoring.md → "Hard-case fixture" + success criteria.

let r: RenderedArticle;
let out: string;

beforeAll(async () => {
  r = await render(HARD_CASES_MD, 'Hard cases', 'Every tricky corner.');
  out = html(r.blocks);
});

describe('hard-cases.md blocks', () => {
  it('shifts headings so the shallowest level (#) becomes h2 and the rest nest', () => {
    expect(out).toContain('<h2 id="hard-cases-for-the-content-pipeline">Hard Cases for the Content Pipeline</h2>');
    expect(out).toContain('<h3 id="abbreviations-and-numbers">');
    expect(out).toContain('<h4 id="unicode-and-emoji">');
    expect(out).not.toMatch(/<h1[\s>]/);
  });

  it('renders the GFM table inside a scroll wrapper', () => {
    expect(out).toMatch(/<div class="table-scroll"><table>\s*<thead>\s*<tr>\s*<th>Format<\/th>/);
    expect(out.match(/<tr>/g)).toHaveLength(4);
    expect(out.match(/<td>/g)).toHaveLength(9);
  });

  it('highlights the ts code block with per-token colours for both themes', () => {
    const pre = /<pre class="shiki shiki-themes github-light github-dark"[^>]*>[\s\S]*?<\/pre>/.exec(out)?.[0] ?? '';

    expect(pre).toContain('export');
    expect(pre).toMatch(/<span style="--shiki-light:#[0-9A-Fa-f]{6};--shiki-dark:#[0-9A-Fa-f]{6}">\s*greet<\/span>/);
    expect(pre).toContain('--shiki-light-bg:');
    expect(pre).toContain('--shiki-dark-bg:');
  });

  it('renders the unknown-language fence as escaped plain text in a shiki pre', () => {
    expect(out).toMatch(/<pre class="shiki[^"]*"[^>]*><code><span class="line"><span>this block uses an unknown language\. It must render as plain text\.<\/span><\/span><\/code><\/pre>/);
  });

  it('keeps inline code as <code>', () => {
    expect(out).toContain('Call <code>a.b()</code> to run');
  });

  it('renders footnotes as a visible Notes section with references and back-references', () => {
    expect(out).toContain('<section data-footnotes class="footnotes"><h2 class="footnotes-label" id="footnote-label">Notes</h2>');
    expect(out).not.toContain('sr-only');
    expect(out).toContain('<sup><a href="#user-content-fn-1" id="user-content-fnref-1" data-footnote-ref');
    expect(out).toContain('href="#user-content-fn-note"');
    expect(out).toContain('The first footnote explains a detail. It contains two sentences.');
    expect(out).toContain('href="#user-content-fnref-note"');
  });

  it('turns an image alone on a line into figure.mdfig with its title as caption', () => {
    expect(out).toContain(
      '<figure class="mdfig"><img src="/media/test/pipeline.png" alt="A diagram of the rendering pipeline" loading="lazy"><figcaption>The rendering pipeline, end to end</figcaption></figure>',
    );
  });

  it('renders an inline image as img.mdimg', () => {
    expect(out).toContain('<img src="/media/test/icon.png" alt="tiny icon" loading="lazy" class="mdimg">');
  });

  it('renders the horizontal rule', () => {
    expect(out).toContain('<hr>');
  });

  it('opens the external link in a new tab with the design inline class', () => {
    expect(out).toContain(
      '<a href="https://docs.example.co.uk/guide.v2.html" class="inline" target="_blank" rel="noopener noreferrer">docs.example.co.uk/guide.v2.html</a>',
    );
  });

  it('renders strong, lists (tight on <li>, loose on <p>) and the blockquote', () => {
    expect(out).toContain('<strong>Humans are creatures of convenience.</strong> Even');
    expect(out).toMatch(/<ul>\s*<li id="p-[0-9a-f]{8}" data-pid="p-[0-9a-f]{8}" class="para">First tight item/);
    expect(out).toMatch(/<ul>\s*<li id="p-[0-9a-f]{8}" data-pid="p-[0-9a-f]{8}" class="para">A nested tight item/);
    expect(out).toMatch(/<ol>\s*<li>\s*<p id="p-[0-9a-f]{8}" data-pid="p-[0-9a-f]{8}" class="para">The first loose item/);
    expect(out).toMatch(/<blockquote>\s*<p id="p-[0-9a-f]{8}" data-pid="p-[0-9a-f]{8}" class="para">Dependent on the eye/);
  });

  it('renders GFM strikethrough as <del>, also inside a task item', () => {
    expect(out).toContain('The old plan was <del>to ship everything at once</del> quietly dropped.');
    expect(out).toContain('Review the <del>first</del> opening draft');
    expect(out).not.toContain('~~');
  });

  it('renders the GFM task list with disabled checkboxes and paragraph ids on the <li>', () => {
    expect(out).toContain('<ul class="contains-task-list">');
    expect(out).toMatch(
      /<li class="para task-list-item" id="p-[0-9a-f]{8}" data-pid="p-[0-9a-f]{8}"><input type="checkbox" disabled> Write the remaining chapters of the guide<\/li>/,
    );
    expect(out).toMatch(
      /<li class="para task-list-item" id="p-[0-9a-f]{8}" data-pid="p-[0-9a-f]{8}"><input type="checkbox" checked disabled> Review the /,
    );
    expect(out).not.toMatch(/\[[ x]\]/);
  });

  it('emits only inert checkbox inputs: every <input> is a disabled checkbox with no name, value or handler', () => {
    const inputs = out.match(/<input[^>]*>/g) ?? [];

    expect(inputs).toEqual(['<input type="checkbox" disabled>', '<input type="checkbox" checked disabled>']);
    expect(out).not.toMatch(/<(form|button|select|textarea|script|iframe)[\s>]/);
    expect(out).not.toMatch(/\son[a-z]+=/i);
  });

  it('keeps non-ASCII text and emoji intact', () => {
    expect(out).toContain('Madhupiṇḍikasutta');
    expect(out).toContain('🎉');
  });

  it('drops the raw HTML line completely', () => {
    expect(out).not.toContain('This raw HTML line must never reach the page');
    expect(out).not.toContain('class="raw"');
    expect(out).not.toMatch(/<div(?! class="table-scroll")/);
  });

  it('splits the blocks at the figure markers: known slide47 and unknown does-not-exist', () => {
    const kinds = r.blocks.map((b) => (b.kind === 'figure' ? `fig:${b.figureId}:${b.known}` : 'html'));

    expect(kinds).toEqual(['html', 'fig:slide47:true', 'fig:does-not-exist:false', 'html']);
    expect(out).not.toContain('@@fig');
  });

  it('reports UNKNOWN_CODE_LANG, RAW_HTML_DROPPED and UNKNOWN_FIGURE with line numbers, in document order', () => {
    expect(r.warnings.map((w) => [w.code, w.line])).toEqual([
      ['UNKNOWN_CODE_LANG', 58],
      ['RAW_HTML_DROPPED', 80],
      ['UNKNOWN_FIGURE', 84],
    ]);
    expect(r.warnings[0].message).toContain('foo');
    expect(r.warnings[2].message).toContain('does-not-exist');
  });
});

describe('hard-cases.md paragraphs', () => {
  it('gives every paragraph a p-<8 hex> id from its own text and renders it on the element', () => {
    for (const p of r.paragraphs) {
      expect(p.pid).toMatch(/^p-[0-9a-f]{8}(-\d+)?$/);
      expect(p.pid.startsWith(paragraphHash(p.text))).toBe(true);
      // Attribute order is not part of the contract (task items carry remark-gfm's class first).
      const tags = out.match(new RegExp(`<(?:p|li)\\b[^>]*\\sid="${p.pid}"[^>]*>`, 'g')) ?? [];
      expect(tags).toHaveLength(1);
      expect(tags[0]).toContain(`data-pid="${p.pid}"`);
      expect(tags[0]).toMatch(/\sclass="(?:[^"]*\s)?para(?:\s[^"]*)?"/);
    }
    expect(r.paragraphs.map((p) => p.index)).toEqual(r.paragraphs.map((_, i) => i));
  });

  it('suffixes the duplicate paragraph with -2 in document order', () => {
    const dups = r.paragraphs.filter((p) => p.text === 'This exact paragraph appears twice in the article on purpose.');

    expect(dups.map((p) => p.pid)).toEqual([dups[0].pid, `${dups[0].pid}-2`]);
    expect(dups[0].pid).toMatch(/^p-[0-9a-f]{8}$/);
  });

  it('classifies paragraph kinds and records heading paths', () => {
    const byText = (start: string) => r.paragraphs.find((p) => p.text.startsWith(start));

    expect(byText('First tight item')).toMatchObject({ kind: 'li', headingPath: ['Hard Cases for the Content Pipeline', 'Lists'] });
    expect(byText('The first loose item')?.kind).toBe('li');
    expect(byText('Dependent on the eye')).toMatchObject({ kind: 'quote', headingPath: ['Hard Cases for the Content Pipeline', 'Quotes'] });
    expect(byText('The discourse in MN 18')?.headingPath).toEqual([
      'Hard Cases for the Content Pipeline',
      'Abbreviations and Numbers',
      'Unicode and Emoji',
    ]);
    expect(byText('This fixture exercises')?.kind).toBe('p');
    expect(byText('The old plan was')).toMatchObject({ kind: 'p', headingPath: ['Hard Cases for the Content Pipeline', 'Lists'] });
    expect(byText('Write the remaining chapters')).toMatchObject({ kind: 'li', headingPath: ['Hard Cases for the Content Pipeline', 'Lists'] });
    expect(byText('Review the first opening draft')?.kind).toBe('li');
  });

  it('builds plain text without markup, images or footnote references', () => {
    const texts = r.paragraphs.map((p) => p.text);

    expect(texts).toContain('Humans are creatures of convenience. Even the smallest barrier to acting discourages most of us from starting.');
    expect(texts).toContain('An inline image sits in the middle of this sentence on purpose.');
    expect(texts).toContain('This sentence carries the first footnote for the test suite. This one carries a named footnote for good measure.');
    expect(texts).toContain('Call a.b() to run the inline example from the documentation page.');
    expect(texts).toContain('Dependent on the eye and forms, eye-consciousness arises. The meeting of the three is contact. With contact as condition there is feeling.');
    expect(texts).toContain('The old plan was to ship everything at once quietly dropped. Nobody missed it in the weeks after that.');
    expect(texts).toContain('Write the remaining chapters of the guide');
    expect(texts).toContain('Review the first opening draft with the team');
    for (const t of texts) expect(t).not.toMatch(/[*`[\]~]|\s{2}|^\s|\s$/);
  });

  it('excludes headings, code, table cells, footnote definitions, figure markers and the image-only line', () => {
    const texts = r.paragraphs.map((p) => p.text).join('\n');

    for (const absent of ['Hard Cases for the Content Pipeline', 'greet', 'unknown language', 'Selected by', 'The first footnote', 'named footnote adds', '@@fig', 'rendering pipeline, end to end', 'raw HTML line']) {
      expect(texts).not.toContain(absent);
    }
  });
});

describe('hard-cases.md sentences', () => {
  it('does not end sentences at e.g., U.S., Dr. or 3.5%', () => {
    const s = sentenceTexts(r);

    expect(s).toContain('Some tools, e.g. a careful sentence splitter, must not break on common abbreviations.');
    expect(s).toContain('The U.S. market grew by 3.5% last year according to the report we read.');
    expect(s).toContain('Dr. Rao reviewed the numbers twice before the team published them.');
  });

  it('splits the bold-run paragraph into two sentences without asterisks', () => {
    const s = r.sentences.filter((x) => x.pid === r.paragraphs.find((p) => p.text.startsWith('Humans'))?.pid);

    expect(s.map((x) => x.text)).toEqual([
      'Humans are creatures of convenience.',
      'Even the smallest barrier to acting discourages most of us from starting.',
    ]);
  });

  it('splits ?, ! and closing curly quote endings and keeps URLs with dots whole', () => {
    const s = sentenceTexts(r);

    expect(s).toEqual(expect.arrayContaining([
      'Can a machine really tell where one sentence ends and the next begins?',
      'It can, if we are careful!',
      'She said, “The splitter must respect quotes.”',
      'Then the meeting moved on to other business.',
      'The reference guide lives at docs.example.co.uk/guide.v2.html and it explains the whole format.',
      'Shipping a renderer that handles this text correctly feels great 🎉 every single time.',
    ]));
  });

  it('keeps struck-through text verbatim without ~~ markers and splits that paragraph normally', () => {
    const pid = r.paragraphs.find((p) => p.text.startsWith('The old plan was'))?.pid;

    expect(r.sentences.filter((x) => x.pid === pid).map((x) => x.text)).toEqual([
      'The old plan was to ship everything at once quietly dropped.',
      'Nobody missed it in the weeks after that.',
    ]);
    for (const s of sentenceTexts(r)) expect(s).not.toContain('~');
  });

  it('treats each task item like any other tight list item: one sentence, no checkbox marker', () => {
    const s = sentenceTexts(r);

    expect(s).toContain('Write the remaining chapters of the guide');
    expect(s).toContain('Review the first opening draft with the team');
    for (const x of s) expect(x).not.toMatch(/\[[ x]\]/);
  });

  it('yields no eligible sentence for the 3-word paragraph', () => {
    const pid = r.paragraphs.find((p) => p.text === 'Only three words.')?.pid;

    expect(pid).toBeDefined();
    expect(r.sentences.some((s) => s.pid === pid)).toBe(false);
  });

  it('takes no sentences from code, table cells, headings or footnote definitions', () => {
    const all = sentenceTexts(r).join('\n');

    for (const absent of ['A comment that ends', 'unknown language', 'Hello', 'Selected by', 'Abbreviations and Numbers', 'The first footnote explains', 'named footnote adds']) {
      expect(all).not.toContain(absent);
    }
  });

  it('has eligible-only sentences (>= 5 words) indexed 0..N-1 with sid = pid-s<k>', () => {
    expect(r.sentences.length).toBeGreaterThan(20);
    r.sentences.forEach((s, i) => {
      expect(s.index).toBe(i);
      expect(s.words).toBeGreaterThanOrEqual(5);
      expect(s.words).toBe(s.text.split(/\s+/).length);
      expect(s.sid).toMatch(new RegExp(`^${s.pid}-s\\d+$`));
    });
    expect(new Set(r.sentences.map((s) => s.sid)).size).toBe(r.sentences.length);
  });

  it('makes every sentence a verbatim substring of its paragraph text', () => {
    for (const s of r.sentences) {
      const p = r.paragraphs.find((x) => x.pid === s.pid);
      expect(p?.text).toContain(s.text);
    }
  });
});

describe('hard-cases.md stats and determinism', () => {
  it('counts words over paragraph text and derives read minutes at 230 wpm', () => {
    const words = r.paragraphs.reduce((n, p) => n + p.text.split(/\s+/).length, 0);

    expect(r.stats).toEqual({ words, readMinutes: Math.max(1, Math.ceil(words / 230)) });
  });

  it('renders identical blocks, ids, sentences and fingerprints twice', async () => {
    const again = await render(HARD_CASES_MD, 'Hard cases', 'Every tricky corner.');

    expect(again).toEqual(r);
    expect(r.fingerprints.body).toMatch(/^[0-9a-f]{64}$/);
    expect(r.fingerprints.paragraphs).toMatch(/^[0-9a-f]{64}$/);
    expect(r.fingerprints.sentences).toMatch(/^[0-9a-f]{64}$/);
  });
});
