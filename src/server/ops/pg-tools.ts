import 'server-only';

import { spawn } from 'node:child_process';

import { BackupError } from './backup-manifest';

// Client-tool plumbing for backup/restore (spec/architecture.md §12.3): find `pg_dump` /
// `pg_restore` on PATH and check their major version against the server's; spawn them (and `tar`)
// with the password in PGPASSWORD only — never on the command line, never in an error message.

export type PgTool = 'pg_dump' | 'pg_restore';

export type ToolEnv = Record<string, string | undefined>;

export const installHint = (tool: string): string =>
  `${tool} not found on PATH — install the PostgreSQL 18 client tools ` +
  '(macOS: brew install postgresql@18; Debian/Ubuntu: apt install postgresql-client-18)';

export interface RunResult {
  stdout: string;
  stderr: string;
}

/**
 * Spawns `cmd args…`; resolves on exit 0. ENOENT → BackupError(`notFound`); non-zero exit →
 * BackupError with the last stderr lines (with `secrets` masked). `input` is written to stdin.
 */
export function runTool(
  cmd: string,
  args: readonly string[],
  opts: { env?: ToolEnv; input?: string | Buffer; notFound?: string; secrets?: readonly string[]; cwd?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], {
      env: { ...(opts.env ?? process.env) } as NodeJS.ProcessEnv,
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.stdin.on('error', () => {}); // EPIPE when the tool exits early; the exit code reports it
    child.on('error', (error: NodeJS.ErrnoException) => {
      reject(
        new BackupError(error.code === 'ENOENT' ? (opts.notFound ?? `${cmd} not found on PATH`) : `${cmd}: ${error.message}`),
      );
    });
    child.on('close', (code, signal) => {
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      if (code === 0) return resolve({ stdout, stderr });
      const tail = maskSecrets(stderr.trim().split('\n').slice(-5).join(' | '), opts.secrets ?? []);
      reject(new BackupError(`${cmd} failed (${signal ?? `exit ${code}`})${tail ? `: ${tail}` : ''}`));
    });
    child.stdin.end(opts.input ?? '');
  });
}

/** `pg_dump (PostgreSQL) 18.1 (Homebrew)` → `18.1`; `server_version` `18.1 (Homebrew)` → `18.1`. */
export function parseVersion(text: string): string | null {
  const match = /(\d+)(?:\.(\d+))?/.exec(text);
  return match ? (match[2] === undefined ? match[1] : `${match[1]}.${match[2]}`) : null;
}

export function majorOf(version: string): number {
  return Number.parseInt(version, 10);
}

export interface FoundTool {
  tool: PgTool;
  version: string;
}

/** `<tool> --version` on PATH (from `env`, default process.env). Missing → the install hint. */
export async function findPgTool(tool: PgTool, env?: ToolEnv): Promise<FoundTool> {
  const { stdout } = await runTool(tool, ['--version'], { env, notFound: installHint(tool) });
  const version = parseVersion(stdout);
  if (!version) throw new BackupError(`could not read the ${tool} version from: ${stdout.trim()}`);
  return { tool, version };
}

/** pg_dump/pg_restore must be at least the server's major version. */
export function assertToolVersion(found: FoundTool, serverVersion: string): void {
  if (majorOf(found.version) < majorOf(serverVersion)) {
    throw new BackupError(
      `${found.tool} ${found.version} is older than the server (PostgreSQL ${serverVersion}) — install the PostgreSQL ` +
        `${majorOf(serverVersion)} client tools (macOS: brew install postgresql@${majorOf(serverVersion)}; ` +
        `Debian/Ubuntu: apt install postgresql-client-${majorOf(serverVersion)})`,
    );
  }
}

/** The URL's password (decoded), or null. */
export function urlPassword(url: string): string | null {
  try {
    const password = new URL(url).password;
    return password === '' ? null : decodeURIComponent(password);
  } catch {
    return null;
  }
}

/**
 * The client-tool connection: a password-less `--dbname` URI plus the environment with
 * PGPASSWORD set (when the URL carries one). Query parameters (sslmode, …) are kept.
 */
export function pgEnv(url: string, base: ToolEnv = process.env): { dbname: string; env: ToolEnv; secrets: string[] } {
  const parsed = new URL(url);
  const password = urlPassword(url);
  parsed.password = '';
  const env: ToolEnv = { ...base };
  delete env.PGPASSWORD;
  if (password !== null) env.PGPASSWORD = password;
  return { dbname: parsed.toString(), env, secrets: password === null ? [] : [password, new URL(url).password] };
}

/** Replaces every occurrence of each secret with `***`. */
export function maskSecrets(text: string, secrets: readonly string[]): string {
  let masked = text;
  for (const secret of secrets) if (secret !== '') masked = masked.split(secret).join('***');
  return masked;
}

/** `name` for messages: the URL's database name (never the URL itself). */
export function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}
