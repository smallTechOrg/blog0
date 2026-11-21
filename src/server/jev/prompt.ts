import 'server-only';

import { readFileSync } from 'node:fs';
import path from 'node:path';

// Versioned TLDR rank prompt (spec/agent.md §4). Any wording change → a new file + bump
// RANK_PROMPT_VERSION; old files stay for audit (rank-v1.md was the decisions-model prompt,
// select-v1.md the first chat prompt). The version is stored on every generation row and fixture.
//
// File format: a `# <version>` title, then exactly two sections `## system` and `## user`.
// Placeholders (user section only): {{title}}, {{dek}}, {{article}}, {{sentences}}.

export const RANK_PROMPT_VERSION = 'tldr-rank-v2';
export const RANK_PROMPT_FILE = 'rank-v2.md';
/** Kept for the generation rows/fixtures that name it. */
export const JEV_PROMPT_VERSION = RANK_PROMPT_VERSION;

export interface RankPrompt {
  version: string;
  system: string;
  /** Template with the {{title}} {{dek}} {{article}} {{sentences}} placeholders. */
  user: string;
}

/** Resolved from the repo root (every command runs there — see README), like the seed posts. */
export function promptPath(file: string = RANK_PROMPT_FILE): string {
  return path.join(process.cwd(), 'src', 'server', 'jev', 'prompts', file);
}

const SECTIONS = ['system', 'user'] as const;
const PLACEHOLDERS = ['title', 'dek', 'article', 'sentences'] as const;
const PLACEHOLDER_RE = /\{\{\s*([a-z_]+)\s*\}\}/g;

/** Parses a rank prompt file's text. Throws on a missing/empty section, a version mismatch or an unknown placeholder. */
export function parseRankPrompt(text: string, version: string = RANK_PROMPT_VERSION): RankPrompt {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const title = lines.find((l) => l.trim() !== '');
  const titleMatch = title ? /^#\s+(\S+)\s*$/.exec(title.trim()) : null;
  if (!titleMatch) throw new Error(`Rank prompt ${version}: the first line must be "# ${version}"`);
  if (titleMatch[1] !== version) throw new Error(`Rank prompt file is "${titleMatch[1]}", expected "${version}"`);

  const sections = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of lines) {
    const heading = /^##\s+(\S+)\s*$/.exec(line.trim());
    if (heading) {
      if (sections.has(heading[1])) throw new Error(`Rank prompt ${version}: duplicate section "## ${heading[1]}"`);
      current = [];
      sections.set(heading[1], current);
    } else if (current) {
      current.push(line);
    }
  }
  for (const name of sections.keys()) {
    if (!(SECTIONS as readonly string[]).includes(name)) throw new Error(`Rank prompt ${version}: unknown section "## ${name}"`);
  }
  const body = (name: (typeof SECTIONS)[number]): string => {
    const value = sections.get(name)?.join('\n').trim() ?? '';
    if (value === '') throw new Error(`Rank prompt ${version}: missing or empty section "## ${name}"`);
    return value;
  };
  const prompt: RankPrompt = { version, system: body('system'), user: body('user') };

  if (/\{\{\s*[a-z_]+\s*\}\}/.test(prompt.system)) throw new Error(`Rank prompt ${version}: the system section may not contain placeholders`);
  const names = [...prompt.user.matchAll(PLACEHOLDER_RE)].map((m) => m[1]);
  const unknown = names.find((n) => !(PLACEHOLDERS as readonly string[]).includes(n));
  if (unknown) throw new Error(`Rank prompt ${version}: unknown placeholder {{${unknown}}}`);
  if (!names.includes('sentences')) throw new Error(`Rank prompt ${version}: the user section must contain {{sentences}}`);
  return prompt;
}

let cached: RankPrompt | null = null;

/** The parsed rank prompt for RANK_PROMPT_VERSION (read once per process). */
export function loadRankPrompt(): RankPrompt {
  if (cached === null) cached = parseRankPrompt(readFileSync(promptPath(), 'utf8'));
  return cached;
}

export interface RankSlots {
  title: string;
  dek: string;
  article: string;
  /** One `<id>: <sentence>` line per sentence. */
  sentences: string;
}

/** Fills the user template. Values are inserted verbatim (they sit inside the tagged blocks). */
export function renderUser(prompt: RankPrompt, slots: RankSlots): string {
  return prompt.user.replace(PLACEHOLDER_RE, (_, name: keyof RankSlots) => slots[name] ?? '');
}

/** One sentence line in the {{sentences}} list. */
export function sentenceLine(sid: string, text: string): string {
  return `${sid}: ${text.replace(/\s+/g, ' ').trim()}`;
}
