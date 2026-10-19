// pnpm admin:create --email b@smalltech.in --name "B Writer"
// Adds another admin to the site (BLOG0_SITE_SLUG) in BLOG0_DATABASE_URL. The password comes from
// BLOG0_NEW_ADMIN_PASSWORD, or an interactive hidden prompt (asked twice) when unset on a terminal.
// Never prints the password; the email is masked in the output.
import { requireSiteId, runCli, siteSlugFromEnv } from './lib/cli';
import { promptHidden } from './lib/prompt';

import { loadDatabaseTarget } from '../src/server/config';
import { createDbHandle } from '../src/server/db/client';
import { maskEmail } from '../src/server/log';
import { createAdmin, SeedError, validateNewAdmin } from '../src/server/seed/admin';

const USAGE = 'Usage: pnpm admin:create --email <address> --name "<Display Name>"   (password: BLOG0_NEW_ADMIN_PASSWORD or prompt)';

function parseArgs(argv: string[]): { email?: string; name?: string } {
  const out: { email?: string; name?: string } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const [flag, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    if (flag !== '--email' && flag !== '--name') throw new SeedError(`Unknown argument: ${arg}\n${USAGE}`);
    const value = inline ?? argv[i + 1];
    if (inline === undefined) i += 1;
    if (value === undefined || value.startsWith('--')) throw new SeedError(`${flag} needs a value.\n${USAGE}`);
    if (flag === '--email') out.email = value;
    else out.name = value;
  }
  return out;
}

async function readPassword(): Promise<string> {
  const fromEnv = process.env.BLOG0_NEW_ADMIN_PASSWORD;
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv;
  if (!process.stdin.isTTY) {
    throw new SeedError('No password given — set BLOG0_NEW_ADMIN_PASSWORD (12+ characters) or run in a terminal to be prompted.');
  }
  const cancelled = () => new SeedError('Cancelled.');
  const first = await promptHidden('Password for the new admin (12+ characters): ', cancelled);
  const second = await promptHidden('Repeat the password: ', cancelled);
  if (first !== second) throw new SeedError('The two passwords do not match.');
  return first;
}

runCli('admin:create', async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!args.email || !args.name) throw new SeedError(USAGE);
  const target = loadDatabaseTarget(process.env);
  const slug = siteSlugFromEnv();
  // Validate email + name before prompting, then the password.
  validateNewAdmin({ email: args.email, displayName: args.name, password: 'x'.repeat(12) });
  const credentials = validateNewAdmin({ email: args.email, displayName: args.name, password: await readPassword() });

  const handle = await createDbHandle(target, { max: 1 });
  try {
    const created = await createAdmin(handle.db, await requireSiteId(handle.db, slug), credentials);
    console.log(`admin ${maskEmail(created.email)} (${created.displayName}) created`);
  } finally {
    await handle.close();
  }
});
