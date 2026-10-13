import 'server-only';

import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Designer mode's session secret (spec/architecture.md §11.1, capability designer-mode): when the
// pglite engine runs without BLOG0_SESSION_SECRET, 48 random bytes (base64url) are generated once,
// persisted at var/pglite-session-secret with mode 0600, and read back on every later boot, so
// sessions survive restarts. Never printed or logged.

export const DESIGNER_SECRET_FILE = path.join('var', 'pglite-session-secret');
const SECRET_BYTES = 48;
const MIN_LENGTH = 32;

export class DesignerSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DesignerSecretError';
  }
}

function read(file: string): string {
  const value = readFileSync(file, 'utf8').trim();
  if (value.length < MIN_LENGTH) {
    throw new DesignerSecretError(
      `${file} is damaged (shorter than ${MIN_LENGTH} characters) — delete it and restart to generate a new one (signs everyone out).`,
    );
  }
  return value;
}

/** Reads the persisted designer secret, generating it on first use. `created` is true only on that first call. */
export function ensureDesignerSessionSecret(file: string = path.resolve(/* turbopackIgnore: true */ process.cwd(), DESIGNER_SECRET_FILE)): {
  secret: string;
  created: boolean;
  file: string;
} {
  try {
    return { secret: read(file), created: false, file };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  try {
    // 'wx': never clobber a secret another process wrote a moment ago.
    writeFileSync(file, `${secret}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { secret: read(file), created: false, file };
    throw error;
  }
  chmodSync(file, 0o600); // the umask may have narrowed it further; never wider
  return { secret, created: true, file };
}
