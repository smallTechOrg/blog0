import { describe, expect, it } from 'vitest';

import { html, render } from './helpers';

describe('renderArticle markdown coverage', () => {
  it('renders strikethrough as <del>', async () => {
    const r = await render('This feature is ~~gone~~ back for good now.');

    expect(html(r.blocks)).toContain('<del>gone</del>');
    expect(r.paragraphs[0].text).toBe('This feature is gone back for good now.');
  });

  it('renders task lists with disabled checkboxes and keeps the bookmark on the tight <li>', async () => {
    const r = await render('- [x] Shipped the content pipeline today\n- [ ] Ship the TLDR deck next week');
    const out = html(r.blocks);

    const [first, second] = r.paragraphs;
    expect(out).toContain(`<li class="para task-list-item" id="${first.pid}" data-pid="${first.pid}"><input type="checkbox" checked disabled> Shipped`);
    expect(out).toContain(`<li class="para task-list-item" id="${second.pid}" data-pid="${second.pid}"><input type="checkbox" disabled> Ship the TLDR`);
    expect(r.paragraphs.map((p) => p.text)).toEqual(['Shipped the content pipeline today', 'Ship the TLDR deck next week']);
  });

  it('renders emphasis, bold and hard breaks, with a break counting as a space in plain text', async () => {
    const r = await render('Some *italic* and **bold** words here  \nand after the break.');

    expect(html(r.blocks)).toContain('<em>italic</em>');
    expect(html(r.blocks)).toContain('<br>');
    expect(r.paragraphs[0].text).toBe('Some italic and bold words here and after the break.');
  });

  it('nests headings under the shallowest level used (## → h2, ### → h3, #### → h4, ###### capped at h4)', async () => {
    const out = html((await render('## A\n\nText.\n\n### B\n\n#### C\n\n###### D')).blocks);

    expect(out).toContain('<h2 id="a">A</h2>');
    expect(out).toContain('<h3 id="b">B</h3>');
    expect(out).toContain('<h4 id="c">C</h4>');
    expect(out).toContain('<h4 id="d">D</h4>');
  });

  it('leaves relative links in the same tab and marks them inline', async () => {
    const out = html((await render('See [the archive](/archive) and [mail](mailto:hi@example.com) please.')).blocks);

    expect(out).toContain('<a href="/archive" class="inline">the archive</a>');
    expect(out).toContain('<a href="mailto:hi@example.com" class="inline">mail</a>');
  });

  it('autolinks bare URLs (GFM) and opens them in a new tab', async () => {
    const out = html((await render('Visit https://smalltech.in/ for more details today.')).blocks);

    expect(out).toContain('<a href="https://smalltech.in/" class="inline" target="_blank" rel="noopener noreferrer">https://smalltech.in/</a>');
  });

  it('highlights a fence without language as plain text and an upper-case known language without warning', async () => {
    const r = await render('```\nplain text here\n```\n\n```TS\nconst a = 1;\n```');
    const out = html(r.blocks);

    expect(r.warnings).toEqual([]);
    expect(out).toMatch(/<pre class="shiki[^"]*"[^>]*><code><span class="line"><span>plain text here<\/span>/);
    expect(out).toMatch(/--shiki-light:#[0-9A-F]{6};--shiki-dark:#[0-9A-F]{6}">const<\/span>/i);
  });

  it('highlights every preloaded language without a warning', async () => {
    const langs = ['ts', 'tsx', 'js', 'jsx', 'json', 'bash', 'shell', 'python', 'sql', 'yaml', 'markdown', 'html', 'css', 'go', 'rust', 'diff'];

    const r = await render(langs.map((l) => '```' + l + '\nx = 1\n```').join('\n\n'));

    expect(r.warnings).toEqual([]);
    expect(html(r.blocks).match(/<pre class="shiki/g)).toHaveLength(langs.length);
  });

  it('turns @@fig markers into figure blocks only when they are a whole top-level paragraph', async () => {
    const r = await render('Intro paragraph with some words.\n\n  @@fig:ab-companies@@  \n\nInline @@fig:slide47@@ stays text here.\n\n- @@fig:slide47@@');

    expect(r.blocks.filter((b) => b.kind === 'figure')).toEqual([{ kind: 'figure', figureId: 'ab-companies', known: true }]);
    expect(html(r.blocks)).toContain('Inline @@fig:slide47@@ stays text here.');
    expect(r.warnings).toEqual([]);
  });

  it('emits back-to-back figures as separate blocks with no empty html block between them', async () => {
    const r = await render('@@fig:slide47@@\n\n@@fig:ab-companies@@');

    expect(r.blocks).toEqual([
      { kind: 'figure', figureId: 'slide47', known: true },
      { kind: 'figure', figureId: 'ab-companies', known: true },
    ]);
    expect(r.paragraphs).toEqual([]);
  });

  it('normalises CRLF line endings to the same output as LF', async () => {
    const lf = await render('# Head\n\nFirst paragraph is right here.\n\nSecond one follows it.');
    const crlf = await render('# Head\r\n\r\nFirst paragraph is right here.\r\n\r\nSecond one follows it.');

    expect(crlf).toEqual(lf);
  });
});

describe('renderArticle edge cases', () => {
  it('returns no blocks, no sentences, 1 read minute and an EMPTY_BODY warning for an empty body', async () => {
    const r = await render('   \n\n  ');

    expect(r.blocks).toEqual([]);
    expect(r.paragraphs).toEqual([]);
    expect(r.sentences).toEqual([]);
    expect(r.stats).toEqual({ words: 0, readMinutes: 1 });
    expect(r.warnings.map((w) => w.code)).toEqual(['EMPTY_BODY']);
  });

  it('renders a body of only headings with no paragraphs and no sentences', async () => {
    const r = await render('# One\n\n## Two');

    expect(r.paragraphs).toEqual([]);
    expect(r.sentences).toEqual([]);
    expect(html(r.blocks)).toContain('<h2 id="one">One</h2>');
  });

  it('handles a long article (200k chars) in one render', async () => {
    const para = 'This is a reasonably long sentence about software and humans. ';
    const body = Array.from({ length: 600 }, (_, i) => `${para.repeat(5)}Number ${i} ends here.`).join('\n\n');

    const r = await render(body.slice(0, 200_000));

    expect(r.paragraphs.length).toBeGreaterThan(500);
    expect(r.sentences.length).toBeGreaterThan(2500);
    expect(new Set(r.paragraphs.map((p) => p.pid)).size).toBe(r.paragraphs.length);
  });
});

describe('renderArticle sanitisation', () => {
  it('drops block raw HTML (script, style, iframe) and reports each with its line', async () => {
    const r = await render('Safe paragraph text goes here.\n\n<script>alert(1)</script>\n\n<iframe src="https://evil.example"></iframe>\n\n<style>body{display:none}</style>');
    const out = html(r.blocks);

    expect(out).not.toMatch(/<script|<iframe|<style|alert\(1\)|display:none/);
    expect(r.warnings.map((w) => [w.code, w.line])).toEqual([
      ['RAW_HTML_DROPPED', 3],
      ['RAW_HTML_DROPPED', 5],
      ['RAW_HTML_DROPPED', 7],
    ]);
  });

  it('drops inline raw HTML and event-handler attributes but keeps the surrounding text', async () => {
    const r = await render('Hello <img src=x onerror="alert(1)"> world <b onclick="x()">bold</b> end of line.');
    const out = html(r.blocks);

    expect(out).not.toMatch(/onerror|onclick|<b>|<img/);
    expect(out).toContain('Hello  world bold end of line.');
    expect(r.paragraphs[0].text).toBe('Hello world bold end of line.');
    expect(r.warnings.every((w) => w.code === 'RAW_HTML_DROPPED')).toBe(true);
    expect(r.warnings).toHaveLength(3);
  });

  it.each([
    ['javascript:alert(1)'],
    ['JaVaScRiPt:alert(1)'],
    ['vbscript:msgbox(1)'],
    ['data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=='],
  ])('removes the href of a link to %s and keeps its text', async (url) => {
    const out = html((await render(`Click [here please](${url}) for nothing at all.`)).blocks);

    expect(out).toContain('<a class="inline">here please</a>');
    expect(out.toLowerCase()).not.toMatch(/javascript:|vbscript:|data:text/);
  });

  it('removes a javascript: autolink href and an unsafe image', async () => {
    const out = html((await render('Auto <javascript:alert(1)> link.\n\nPic ![x](javascript:alert(1)) here.\n\n![alone](data:image/svg+xml,<svg/onload=alert(1)>)')).blocks);

    expect(out).toContain('<a class="inline">javascript:alert(1)</a>');
    expect(out.toLowerCase()).not.toMatch(/href="\s*javascript|src=|onload/);
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<p></p>');
  });

  it('escapes HTML special characters in text, link titles and image alt text', async () => {
    const out = html((await render('Use 5 < 6 && "quotes" here [t](/x "a\\"><script>") ok.\n\n![a"b<c](/i.png "t<i>")')).blocks);

    expect(out).toContain('5 &#x3C; 6 &#x26;&#x26; "quotes"');
    // The quote is escaped, so "<script>" stays inert inside the attribute value.
    expect(out).toContain('<a href="/x" title="a&#x22;><script>" class="inline">t</a>');
    expect(out).toContain('alt="a&#x22;b<c"');
    expect(out).toContain('<figcaption>t&#x3C;i></figcaption>');
    expect(out.replace(/"[^"]*"/g, '""')).not.toMatch(/<script|<i>/);
  });
});
