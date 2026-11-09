// pnpm admin:reset-password --email <address>   (locally, via tsx)
// node reset-password.mjs --email <address>     (in the image; bundled by scripts/build-release.mjs)
// Stage A (spec/architecture.md §12.1; capability admin-auth; runbook docs/deploy.md → "Reset an
// admin password"): sets a new password for the admin with that email in BLOG0_SITE_SLUG's site of
// BLOG0_DATABASE_URL, ends ALL of that user's sessions and clears the email's login delay. The
// password comes from BLOG0_NEW_ADMIN_PASSWORD, else a hidden prompt asked twice (a terminal is
// required). Prints only `password reset for <masked email> · <n> sessions ended`.
// Exit 0 ok, 1 failure (unknown admin, DB error), 2 misuse (usage, password rules, no password source).
// Deliberately does NOT import scripts/lib/cli.ts (it pulls the content pipeline into the bundle).
import './lib/allow-server-only';

import { loadEnvConfig } from '@next/env';

import { releaseSiteSlug } from '../src/server/ops/release';
import { ResetPasswordError, runResetPassword } from '../src/server/ops/reset-password';
import { promptHidden } from './lib/prompt';

const USAGE = 'Usage: pnpm admin:reset-password --email <address>   (password: BLOG0_NEW_ADMIN_PASSWORD or a hidden prompt)';

function parseArgs(argv: string[]): string {
  let email: string | undefined;
  const args = argv.filter((a) => a !== '--');
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '--help' || arg === '-h') throw new ResetPasswordError(USAGE, 2);
    const eq = arg.indexOf('=');
    const [flag, inline] = eq > 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];
    if (flag !== '--email') throw new ResetPasswordError(`Unknown argument: ${arg}\n${USAGE}`, 2);
    const value = inline ?? args[i + 1];
    if (inline === undefined) i += 1;
    if (value === undefined || value.startsWith('--') || value.trim() === '') throw new ResetPasswordError(`--email needs a value.\n${USAGE}`, 2);
    email = value;
  }
  if (email === undefined) throw new ResetPasswordError(USAGE, 2);
  return email;
}

async function readPassword(): Promise<string> {
  const fromEnv = process.env.BLOG0_NEW_ADMIN_PASSWORD;
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv;
  if (!process.stdin.isTTY) {
    throw new ResetPasswordError('No password given — set BLOG0_NEW_ADMIN_PASSWORD or run with a terminal to be prompted (12–200 characters).', 2);
  }
  const cancelled = () => new ResetPasswordError('Cancelled.', 2);
  const first = await promptHidden('New password (12–200 characters): ', cancelled);
  const second = await promptHidden('Repeat the new password: ', cancelled);
  if (first !== second) throw new ResetPasswordError('The two passwords do not match.', 2);
  return first;
}

async function main(): Promise<void> {
  const email = parseArgs(process.argv.slice(2));
  loadEnvConfig(process.cwd(), false, { info: () => {}, error: console.error });
  let slug: string;
  try {
    slug = releaseSiteSlug(process.env);
  } catch (error) {
    throw new ResetPasswordError(error instanceof Error ? error.message : String(error), 2);
  }
  const password = await readPassword();
  await runResetPassword({ env: process.env, email, password, slug, out: (line) => console.log(line) });
}

main().catch((error: unknown) => {
  console.error(`reset-password failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(error instanceof ResetPasswordError ? error.exitCode : 1);
});
