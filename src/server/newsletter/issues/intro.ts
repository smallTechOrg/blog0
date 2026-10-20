import 'server-only';

import type { MdNode } from '../../content/ast';
import { parseMarkdown } from '../../content/markdown';
import { esc } from '../mail/templates';

// An issue intro's Markdown → the email-safe inline subset (spec/architecture.md §13.2: paragraphs,
// emphasis, links; figures, code blocks, images, tables and raw HTML are dropped). Parsed with the
// article pipeline's own parser; emitted with `esc()` and inline styles — never as raw HTML.

const SAFE_URL = /^(https?:|mailto:)/i;
const P_STYLE = 'margin:0 0 12px;';
const A_STYLE = 'color:#d64545;text-decoration:underline;';

interface Out {
  html: string;
  text: string;
}

function inline(nodes: MdNode[] | undefined): Out {
  let html = '';
  let text = '';
  for (const n of nodes ?? []) {
    switch (n.type) {
      case 'text':
      case 'inlineCode': {
        const v = n.value ?? '';
        html += esc(v);
        text += v;
        break;
      }
      case 'emphasis': {
        const c = inline(n.children);
        html += `<em>${c.html}</em>`;
        text += c.text;
        break;
      }
      case 'strong': {
        const c = inline(n.children);
        html += `<strong>${c.html}</strong>`;
        text += c.text;
        break;
      }
      case 'delete': {
        const c = inline(n.children);
        html += c.html;
        text += c.text;
        break;
      }
      case 'link': {
        const c = inline(n.children);
        const url = (n.url ?? '').trim();
        if (SAFE_URL.test(url)) {
          html += `<a href="${esc(url)}" class="b0-link" style="${A_STYLE}">${c.html || esc(url)}</a>`;
          text += c.text && c.text !== url ? `${c.text} (${url})` : url;
        } else {
          html += c.html;
          text += c.text;
        }
        break;
      }
      case 'break':
        html += '<br>';
        text += '\n';
        break;
      default:
        // images, footnote references, raw html: dropped
        break;
    }
  }
  return { html, text };
}

function blocks(nodes: MdNode[] | undefined, prefix = ''): Out[] {
  const out: Out[] = [];
  for (const n of nodes ?? []) {
    switch (n.type) {
      case 'paragraph':
      case 'heading': {
        const c = inline(n.children);
        if (c.text.trim() === '' && c.html.trim() === '') break;
        out.push({ html: prefix ? `${esc(prefix)}${c.html}` : c.html, text: `${prefix}${c.text}` });
        break;
      }
      case 'list':
        for (const item of n.children ?? []) out.push(...blocks(item.children, '• '));
        break;
      case 'blockquote':
        out.push(...blocks(n.children, prefix));
        break;
      default:
        // code, html, table, thematicBreak, figures, definitions: dropped
        break;
    }
  }
  return out;
}

/** `introMd` → `{ html, text }` for `IssueRenderInput.introHtml` / `introText` ('' for an empty intro). */
export function renderIntro(introMd: string): Out {
  const md = introMd.replace(/\r\n?/g, '\n');
  if (md.trim() === '') return { html: '', text: '' };
  const paras = blocks(parseMarkdown(md).children);
  return {
    html: paras.map((p) => `<p style="${P_STYLE}">${p.html}</p>`).join('\n'),
    text: paras.map((p) => p.text).join('\n\n'),
  };
}
