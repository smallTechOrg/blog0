import 'server-only';

import { readFileSync } from 'node:fs';
import path from 'node:path';

// Versioned rank prompt (spec/agent.md §4). Any wording change → new file rank-v2.md + bump
// JEV_PROMPT_VERSION; old files stay for audit (select-v1.md, the chat-era prompt stamped
// `jev-select-v1`, is kept unreferenced). The version is stored on every generation row and fixture.
//
// File format: a `# <version>` title, then exactly three sections `## instructions`, `## true`,
// `## false`. `{{sentence}}` (in instructions) is the only placeholder; it is filled with
// JSON.stringify(sentence text) — quoted, inner quotes escaped.

export const JEV_PROMPT_VERSION = 'jev-rank-v1';
export const JEV_PROMPT_FILE = 'rank-v1.md';

export interface RankPrompt {
  version: string;
  /** Template with the `{{sentence}}` placeholder. */
  instructions: string;
  criteriaTrue: string;
  criteriaFalse: string;
}

/** Resolved from the repo root (every command runs there — see README), like the seed posts. */
export function promptPath(file: string = JEV_PROMPT_FILE): string {
  return path.join(process.cwd(), 'src', 'server', 'jev', 'prompts', file);
}

const SECTIONS = ['instructions', 'true', 'false'] as const;
const PLACEHOLDER_RE = /\{\{\s*([a-z_]+)\s*\}\}/g;

/** Parses a rank prompt file's text. Throws on a missing/empty section, a version mismatch or an unknown placeholder. */
export function parseRankPrompt(text: string, version: string = JEV_PROMPT_VERSION): RankPrompt {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const title = lines.find((l) => l.trim() !== '');
  const titleMatch = title ? /^#\s+(\S+)\s*$/.exec(title.trim()) : null;
  if (!titleMatch) throw new Error(`Jev prompt ${version}: the first line must be "# ${version}"`);
  if (titleMatch[1] !== version) throw new Error(`Jev prompt file is "${titleMatch[1]}", expected "${version}"`);

  const sections = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of lines) {
    const heading = /^##\s+(\S+)\s*$/.exec(line.trim());
    if (heading) {
      if (sections.has(heading[1])) throw new Error(`Jev prompt ${version}: duplicate section "## ${heading[1]}"`);
      current = [];
      sections.set(heading[1], current);
    } else if (current) {
      current.push(line);
    }
  }
  const body = (name: (typeof SECTIONS)[number]): string => {
    const value = sections.get(name)?.join('\n').trim() ?? '';
    if (value === '') throw new Error(`Jev prompt ${version}: missing or empty section "## ${name}"`);
    return value;
  };
  for (const name of sections.keys()) {
    if (!(SECTIONS as readonly string[]).includes(name)) throw new Error(`Jev prompt ${version}: unknown section "## ${name}"`);
  }
  const prompt: RankPrompt = { version, instructions: body('instructions'), criteriaTrue: body('true'), criteriaFalse: body('false') };

  const names = [...prompt.instructions.matchAll(PLACEHOLDER_RE)].map((m) => m[1]);
  if (!names.includes('sentence')) throw new Error(`Jev prompt ${version}: instructions must contain {{sentence}}`);
  const unknown = names.find((n) => n !== 'sentence');
  if (unknown) throw new Error(`Jev prompt ${version}: unknown placeholder {{${unknown}}}`);
  for (const text of [prompt.criteriaTrue, prompt.criteriaFalse]) {
    if (/\{\{\s*[a-z_]+\s*\}\}/.test(text)) throw new Error(`Jev prompt ${version}: criteria may not contain placeholders`);
  }
  return prompt;
}

let cached: RankPrompt | null = null;

/** The parsed rank prompt for JEV_PROMPT_VERSION (read once per process). */
export function loadRankPrompt(): RankPrompt {
  if (cached === null) cached = parseRankPrompt(readFileSync(promptPath(), 'utf8'));
  return cached;
}

/** Fills `{{sentence}}` with JSON.stringify(text) (quoted, inner quotes and control characters escaped). */
export function renderInstructions(prompt: RankPrompt, sentenceText: string): string {
  return prompt.instructions.replace(PLACEHOLDER_RE, () => JSON.stringify(sentenceText));
}
