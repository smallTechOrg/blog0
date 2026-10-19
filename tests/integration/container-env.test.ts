// `pnpm test:container` (scripts/container-e2e.sh) runs the full E2E suite — incl. the newsletter
// signup walk — against a container whose env file scripts/lib/container-env.mjs builds from .env +
// the shell. A configured real relay or Listmonk must never reach that container: the env file forces
// the stub mail transport (BLOG0_SMTP_HOST empty) and the stub sender, and carries no SMTP / Listmonk
// credentials.
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const dir = mkdtempSync(path.join(tmpdir(), 'blog0-container-env-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function parse(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out.set(line.slice(0, i), line.slice(i + 1));
  }
  return out;
}

async function build(extra: Record<string, string>): Promise<Map<string, string>> {
  const file = path.join(dir, `env-${Object.keys(extra).length}-${Date.now()}`);
  await promisify(execFile)(process.execPath, ['scripts/lib/container-env.mjs', 'env'], {
    cwd: ROOT,
    // The setup file points BLOG0_DATABASE_URL at the test DB; the script refuses when the two are equal.
    env: { ...process.env, BLOG0_DATABASE_URL: 'postgres://localhost:5432/blog0_dev_stand_in', ...extra, CONTAINER_ENV_FILE: file },
    timeout: 30_000,
  });
  return parse(readFileSync(file, 'utf8'));
}

describe('container env file (pnpm test:container)', () => {
  it('a real relay + Listmonk in the environment → the container gets the stub transport + stub sender, no SMTP/Listmonk credentials', async () => {
    const vars = await build({
      BLOG0_SMTP_HOST: 'smtp-relay.gmail.com',
      BLOG0_SMTP_PORT: '587',
      BLOG0_SMTP_USER: 'owner@example.test',
      BLOG0_SMTP_PASS: 'not-a-real-password-0001',
      BLOG0_SMTP_FROM: 'blog0 <owner@example.test>',
      BLOG0_NEWSLETTER_SENDER: 'listmonk',
      BLOG0_LISTMONK_URL: 'http://localhost:9000',
      BLOG0_LISTMONK_API_USER: 'blog0',
      BLOG0_LISTMONK_API_TOKEN: 'not-a-real-token-0001',
      BLOG0_LISTMONK_LIST_ID: '3',
    });
    expect(vars.get('BLOG0_SMTP_HOST')).toBe('');
    expect(vars.get('BLOG0_NEWSLETTER_SENDER')).toBe('stub');
    const leaked = [...vars.keys()].filter((k) => (k.startsWith('BLOG0_SMTP_') && k !== 'BLOG0_SMTP_HOST') || k.startsWith('BLOG0_LISTMONK_'));
    expect(leaked).toEqual([]);
    expect([...vars.values()].join('\n')).not.toMatch(/not-a-real-(password|token)-0001|smtp-relay\.gmail\.com/);
  });

  it('nothing newsletter-related configured → still the explicit stubs (an empty host, the stub sender)', async () => {
    const vars = await build({ BLOG0_SMTP_HOST: '', BLOG0_NEWSLETTER_SENDER: '' });
    expect(vars.get('BLOG0_SMTP_HOST')).toBe('');
    expect(vars.get('BLOG0_NEWSLETTER_SENDER')).toBe('stub');
  });
});
