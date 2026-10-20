import 'server-only';

// Minimal structural types for the mdast / hast trees the pipeline walks. `@types/mdast` and
// `@types/hast` are only transitive dependencies (not resolvable from `src/` under pnpm), so the
// pipeline declares the handful of fields it touches and casts at the unified boundaries.

export interface Point { line: number; column: number; offset?: number }
export interface Position { start: Point; end: Point }

export interface MdNode {
  type: string;
  children?: MdNode[];
  value?: string;
  position?: Position;
  data?: { hName?: string; hProperties?: Record<string, unknown> };
  /** heading */
  depth?: number;
  /** code */
  lang?: string | null;
  meta?: string | null;
  /** list / listItem */
  spread?: boolean | null;
  ordered?: boolean | null;
  checked?: boolean | null;
  /** link / image */
  url?: string;
  title?: string | null;
  alt?: string | null;
  /** blog0Figure (figure-markers plugin) */
  figureId?: string;
  known?: boolean;
}

export interface MdRoot extends MdNode { type: 'root'; children: MdNode[] }

export interface HNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HNode[];
  value?: string;
}

export interface HElement extends HNode {
  type: 'element';
  tagName: string;
  properties: Record<string, unknown>;
  children: HNode[];
}

export interface HRoot extends HNode { type: 'root'; children: HNode[] }

export const SKIP = Symbol('skip');

/**
 * Depth-first, document-order walk. The visitor receives the node, its parent and the ancestor
 * chain (root first). Returning SKIP does not descend into the node's children. The visitor may
 * replace `parent.children[index]` in place; the walk then visits the replacement's children.
 */
export function walk<N extends { children?: N[] }>(
  root: N,
  visit: (node: N, index: number, parent: N, ancestors: readonly N[]) => typeof SKIP | void,
): void {
  const ancestors: N[] = [];
  const go = (parent: N): void => {
    const kids = parent.children;
    if (!kids) return;
    ancestors.push(parent);
    for (let i = 0; i < kids.length; i++) {
      const result = visit(kids[i], i, parent, ancestors);
      if (result !== SKIP) go(kids[i]);
    }
    ancestors.pop();
  };
  go(root);
}

export function isElement(node: HNode, tagName?: string): node is HElement {
  return node.type === 'element' && (tagName === undefined || node.tagName === tagName);
}

export function classList(el: HElement): string[] {
  const value = el.properties.className;
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return value.split(/\s+/).filter(Boolean);
  return [];
}

export function addClass(el: HElement, ...names: string[]): void {
  const current = classList(el);
  for (const name of names) if (!current.includes(name)) current.push(name);
  el.properties.className = current;
}

export function isWhitespaceText(node: HNode): boolean {
  return node.type === 'text' && !(node.value ?? '').trim();
}
