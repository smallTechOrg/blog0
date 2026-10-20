// Global setup for playwright.design.config.ts (capability designer-mode).
//
// Playwright starts the web server (`pnpm dev:design` on 3413, after wiping var/pglite-e2e*) BEFORE
// this runs, so by now the designer setup has migrated + seeded the throwaway PGlite dir. This step:
//   1. proves the run started from a clean state — the server console shows a first boot (initdb)
//      and exactly ONE designer admin line carrying a freshly generated password;
//   2. reads the generated credentials from var/pglite-e2e.designer-admin.txt (the designer-mode
//      credentials file — NOT .env) and checks they match the printed line;
//   3. hands them to the test workers as BLOG0_E2E_DESIGNER_* (workers inherit process.env).
// The password is never printed.
import { existsSync, readFileSync, statSync } from 'node:fs';

export const DESIGN_E2E_PORT = Number(process.env.BLOG0_DESIGN_E2E_PORT) || 3413;
export const DESIGN_E2E_DIR = 'var/pglite-e2e';
export const DESIGN_E2E_ADMIN_FILE = `${DESIGN_E2E_DIR}.designer-admin.txt`;
/** Own storage dir (wiped with the PGlite dir), so a designer's ./var/storage is never touched. */
export const DESIGN_E2E_STORAGE_DIR = 'var/storage-design-e2e';
export const DESIGN_E2E_SERVER_LOG = 'test-results/design-e2e-server.log';
export const DESIGNER_EMAIL = 'designer@blog0.local';

export const DESIGNER_ENV = {
  email: 'BLOG0_E2E_DESIGNER_EMAIL',
  password: 'BLOG0_E2E_DESIGNER_PASSWORD',
} as const;

export function readDesignerCredentials(file: string): { email: string; password: string } {
  const text = readFileSync(file, 'utf8');
  const email = /^email:\s*(\S+)\s*$/m.exec(text)?.[1] ?? '';
  const password = /^password:\s*(\S+)\s*$/m.exec(text)?.[1] ?? '';
  if (email === '' || password === '') throw new Error(`${file} has no "email:" / "password:" lines`);
  return { email, password };
}

const READY_BANNER = /^blog0 designer mode is ready /m;

/** dev:design prints its banner (with the credentials line) a moment after /api/health answers. */
async function waitForBanner(timeoutMs = 120_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = existsSync(DESIGN_E2E_SERVER_LOG) ? readFileSync(DESIGN_E2E_SERVER_LOG, 'utf8') : '';
    if (READY_BANNER.test(text)) return text;
    if (Date.now() > deadline) throw new Error(`no "blog0 designer mode is ready" banner in ${DESIGN_E2E_SERVER_LOG} within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

export default async function globalSetup(): Promise<void> {
  if (!existsSync(DESIGN_E2E_SERVER_LOG)) throw new Error(`${DESIGN_E2E_SERVER_LOG} missing — the web server command did not run`);
  const serverConsole = await waitForBanner();

  if (!/^database: .*\(new — first boot runs initdb\)/m.test(serverConsole)) {
    throw new Error(`designer E2E did not start from a clean PGlite dir (no first-boot line in ${DESIGN_E2E_SERVER_LOG})`);
  }
  const adminLines = serverConsole.split('\n').filter((l) => l.startsWith('designer admin: '));
  if (adminLines.length !== 1 || !adminLines[0].includes('shown once')) {
    throw new Error(`expected exactly one "designer admin: … (shown once …)" line, got ${adminLines.length}`);
  }

  if (!existsSync(DESIGN_E2E_ADMIN_FILE)) throw new Error(`${DESIGN_E2E_ADMIN_FILE} was not written by pnpm dev:design`);
  const mode = statSync(DESIGN_E2E_ADMIN_FILE).mode & 0o777;
  if (mode !== 0o600) throw new Error(`${DESIGN_E2E_ADMIN_FILE} has mode ${mode.toString(8)}, expected 600`);
  const creds = readDesignerCredentials(DESIGN_E2E_ADMIN_FILE);
  if (creds.email !== DESIGNER_EMAIL) throw new Error(`${DESIGN_E2E_ADMIN_FILE} names ${creds.email}, expected ${DESIGNER_EMAIL}`);
  if (!adminLines[0].includes(`${creds.email} / ${creds.password} `)) {
    throw new Error(`the printed designer password does not match ${DESIGN_E2E_ADMIN_FILE}`);
  }

  process.env[DESIGNER_ENV.email] = creds.email;
  process.env[DESIGNER_ENV.password] = creds.password;
}
