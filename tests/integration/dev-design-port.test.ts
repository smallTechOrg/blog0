// pnpm dev:design refuses a taken port BEFORE it touches the database (scripts/dev-design.mjs
// step 3; capability designer-mode): a second dev:design on the same PGlite dir must never open
// it twice. We hold a free port with a plain net server, spawn the real script on it with a scratch
// pglite dir, and assert exit 1 + the "already in use" message + no data dir created.
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SCRATCH_REL = './var/pglite-porttest';
const SCRATCH_ABS = path.resolve(ROOT, SCRATCH_REL);

let blocker: net.Server;
let port: number;

beforeAll(async () => {
  rmSync(SCRATCH_ABS, { recursive: true, force: true });
  blocker = net.createServer();
  // Same bind as the script's probe (no host → all interfaces), on an OS-assigned free port.
  await new Promise<void>((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(0, () => resolve());
  });
  port = (blocker.address() as net.AddressInfo).port;
  expect(port).not.toBe(3410);
});

afterAll(async () => {
  await new Promise<void>((resolve) => blocker.close(() => resolve()));
  rmSync(SCRATCH_ABS, { recursive: true, force: true });
});

function runDevDesign(env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dev-design.mjs')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`dev:design did not exit within 30 s on a taken port\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 30_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

describe('dev:design on a port that is already in use', () => {
  it('exits 1 with "already in use" and never creates the PGlite data dir', async () => {
    const { code, stdout, stderr } = await runDevDesign({
      ...process.env,
      BLOG0_PORT: String(port),
      BLOG0_DATABASE_URL: `pglite://${SCRATCH_REL}`,
      BLOG0_PUBLIC_BASE_URL: '',
    });
    expect(code, `stdout:\n${stdout}\nstderr:\n${stderr}`).toBe(1);
    expect(stderr).toContain(`port ${port} is already in use`);
    expect(stderr).toContain(`BLOG0_PORT=${port + 10} pnpm dev:design`);
    expect(stdout).not.toContain('preparing the database');
    expect(existsSync(SCRATCH_ABS)).toBe(false);
  });
});
