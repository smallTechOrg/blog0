import 'server-only';

import packageJson from '../../package.json';

// Typed, validated environment (spec/architecture.md §10). Documented 1:1 in .env.example.
// `loadConfig(env)` is pure; `getConfig()` caches it. Never read config at module top level.

export const APP_VERSION: string = packageJson.version;

/**
 * Ends the process after a fatal boot problem. Next.js only logs errors thrown from the
 * instrumentation hook and keeps listening, which would serve 500s with an invalid config.
 */
export function exitProcess(code: number): never {
  process.exit(code);
}

/** Runtime identity for the `app.boot` log line. */
export function runtimeInfo(): { version: string; node: string } {
  return { version: APP_VERSION, node: process.version };
}

const INSPECT = Symbol.for('nodejs.util.inspect.custom');

/** Wraps a secret so it never leaks through JSON.stringify, String(), template literals or util.inspect. */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** Unwrap only at the boundary where the secret is actually used. */
  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return '[redacted]';
  }

  toString(): string {
    return '[redacted]';
  }

  [INSPECT](): string {
    return '[redacted]';
  }
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export interface Config {
  databaseUrl: string;
  testDatabaseUrl: string | null;
  port: number;
  publicBaseUrl: string;
  siteSlug: string;
  sessionSecret: Secret;
  openrouterApiKey: Secret;
  openrouterBaseUrl: string;
  jevModel: string;
  jevTimeoutMs: number;
  logLevel: LogLevel;
  logFile: string | null;
  adminEmail: string | null;
  adminPassword: Secret | null;
  adminName: string;
  newAdminPassword: Secret | null;
  storageDir: string;
  maxAudioMb: number;
  maxAudioMinutes: number;
  maxImageMb: number;
  e2eBaseUrl: string | null;
  /** Reverse proxies in front of the app that append to X-Forwarded-For (0 = none: never trust it). */
  trustedProxyHops: number;
  isProduction: boolean;
}

export const CONFIG_DEFAULTS = {
  port: 3410,
  publicBaseUrl: 'http://localhost:3410',
  siteSlug: 'blog0',
  openrouterBaseUrl: 'https://openrouter.ai/api/v1',
  jevModel: 'google/gemini-2.5-flash',
  jevTimeoutMs: 45_000,
  logLevel: 'info' as LogLevel,
  adminName: 'Sai Krishna V',
  storageDir: './var/storage',
  maxAudioMb: 50,
  maxAudioMinutes: 30,
  maxImageMb: 8,
  trustedProxyHops: 0,
} as const;

export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(
      `Invalid configuration — fix these in .env (see .env.example):\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

type Env = Record<string, string | undefined>;

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Non-secret value: trimmed, a trailing ` # comment` stripped (dirty .env tolerance); empty → undefined. */
function plain(env: Env, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const value = raw.replace(/\s+#.*$/, '').trim();
  return value === '' ? undefined : value;
}

/** Secret value: trimmed only (a `#` may legitimately appear in a secret); empty → undefined. */
function secret(env: Env, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const value = raw.trim();
  return value === '' ? undefined : value;
}

/** `.env.example` ships secrets as `replace-with-…`; a copied-but-unedited value must never boot. */
const PLACEHOLDER_PREFIX = 'replace-with-';

function isPlaceholder(value: string): boolean {
  return value.startsWith(PLACEHOLDER_PREFIX);
}

/** The value itself is never echoed — only the variable name. */
function placeholderProblem(name: string): string {
  return `${name} still holds the .env.example placeholder — set a real value in .env`;
}

function isPostgresUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'postgres:' || url.protocol === 'postgresql:') && url.pathname.length > 1;
  } catch {
    return false;
  }
}

function httpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return value.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function int(
  problems: string[],
  env: Env,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = plain(env, name);
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
    problems.push(`${name} must be an integer between ${min} and ${max}`);
    return fallback;
  }
  return Number(value);
}

/** Validates the database URL alone (for db:* scripts, which must not need the OpenRouter key). */
export function loadDatabaseUrl(env: Env, name = 'BLOG0_DATABASE_URL'): string {
  const value = plain(env, name);
  if (value === undefined) throw new ConfigError([`${name} is required (e.g. postgres://sai@localhost:5432/blog0_dev)`]);
  if (!isPostgresUrl(value)) throw new ConfigError([`${name} must be a postgres:// URL with a database name`]);
  return value;
}

/** Pure: env → Config, or throws one ConfigError listing every problem. */
export function loadConfig(env: Env): Config {
  const problems: string[] = [];

  const databaseUrl = plain(env, 'BLOG0_DATABASE_URL');
  if (databaseUrl === undefined) {
    problems.push('BLOG0_DATABASE_URL is required (e.g. postgres://sai@localhost:5432/blog0_dev)');
  } else if (!isPostgresUrl(databaseUrl)) {
    problems.push('BLOG0_DATABASE_URL must be a postgres:// URL with a database name');
  }

  const testDatabaseUrl = plain(env, 'BLOG0_TEST_DATABASE_URL') ?? null;
  if (testDatabaseUrl !== null && !isPostgresUrl(testDatabaseUrl)) {
    problems.push('BLOG0_TEST_DATABASE_URL must be a postgres:// URL with a database name');
  }

  const port = int(problems, env, 'BLOG0_PORT', CONFIG_DEFAULTS.port, 1, 65535);

  const rawBase = plain(env, 'BLOG0_PUBLIC_BASE_URL') ?? CONFIG_DEFAULTS.publicBaseUrl;
  const publicBaseUrl = httpUrl(rawBase);
  if (publicBaseUrl === null) problems.push('BLOG0_PUBLIC_BASE_URL must be an absolute http(s) URL');

  const siteSlug = plain(env, 'BLOG0_SITE_SLUG') ?? CONFIG_DEFAULTS.siteSlug;
  if (!SLUG_RE.test(siteSlug)) problems.push('BLOG0_SITE_SLUG must be lowercase words joined by hyphens');

  const sessionSecret = secret(env, 'BLOG0_SESSION_SECRET');
  if (sessionSecret === undefined) {
    problems.push('BLOG0_SESSION_SECRET is required (generate one with: openssl rand -base64 48)');
  } else if (isPlaceholder(sessionSecret)) {
    problems.push(placeholderProblem('BLOG0_SESSION_SECRET'));
  } else if (sessionSecret.length < 32) {
    problems.push('BLOG0_SESSION_SECRET must be at least 32 characters (openssl rand -base64 48)');
  }

  const openrouterApiKey = secret(env, 'BLOG0_OPENROUTER_API_KEY');
  if (openrouterApiKey === undefined) {
    problems.push('BLOG0_OPENROUTER_API_KEY is required (create one at https://openrouter.ai/keys)');
  } else if (isPlaceholder(openrouterApiKey)) {
    problems.push(placeholderProblem('BLOG0_OPENROUTER_API_KEY'));
  }

  const rawOpenrouterBase = plain(env, 'BLOG0_OPENROUTER_BASE_URL') ?? CONFIG_DEFAULTS.openrouterBaseUrl;
  const openrouterBaseUrl = httpUrl(rawOpenrouterBase);
  if (openrouterBaseUrl === null) problems.push('BLOG0_OPENROUTER_BASE_URL must be an absolute http(s) URL');

  const jevModel = plain(env, 'BLOG0_JEV_MODEL') ?? CONFIG_DEFAULTS.jevModel;
  const jevTimeoutMs = int(problems, env, 'BLOG0_JEV_TIMEOUT_MS', CONFIG_DEFAULTS.jevTimeoutMs, 1000, 600_000);

  const logLevelRaw = plain(env, 'BLOG0_LOG_LEVEL') ?? CONFIG_DEFAULTS.logLevel;
  const logLevel = LOG_LEVELS.includes(logLevelRaw as LogLevel) ? (logLevelRaw as LogLevel) : null;
  if (logLevel === null) problems.push(`BLOG0_LOG_LEVEL must be one of ${LOG_LEVELS.join('|')}`);

  const logFile = plain(env, 'BLOG0_LOG_FILE') ?? null;

  const adminEmailRaw = plain(env, 'BLOG0_ADMIN_EMAIL');
  const adminEmail = adminEmailRaw === undefined ? null : adminEmailRaw.toLowerCase();
  if (adminEmail !== null && !EMAIL_RE.test(adminEmail)) problems.push('BLOG0_ADMIN_EMAIL must be an email address');

  const adminPassword = secret(env, 'BLOG0_ADMIN_PASSWORD');
  if (adminPassword !== undefined && isPlaceholder(adminPassword)) {
    problems.push(placeholderProblem('BLOG0_ADMIN_PASSWORD'));
  } else if (adminPassword !== undefined && adminPassword.length < 12) {
    problems.push('BLOG0_ADMIN_PASSWORD must be at least 12 characters');
  }
  const adminName = plain(env, 'BLOG0_ADMIN_NAME') ?? CONFIG_DEFAULTS.adminName;

  const newAdminPassword = secret(env, 'BLOG0_NEW_ADMIN_PASSWORD');
  if (newAdminPassword !== undefined && isPlaceholder(newAdminPassword)) {
    problems.push(placeholderProblem('BLOG0_NEW_ADMIN_PASSWORD'));
  } else if (newAdminPassword !== undefined && newAdminPassword.length < 12) {
    problems.push('BLOG0_NEW_ADMIN_PASSWORD must be at least 12 characters');
  }

  const storageDir = plain(env, 'BLOG0_STORAGE_DIR') ?? CONFIG_DEFAULTS.storageDir;
  const maxAudioMb = int(problems, env, 'BLOG0_MAX_AUDIO_MB', CONFIG_DEFAULTS.maxAudioMb, 1, 10_000);
  const maxAudioMinutes = int(problems, env, 'BLOG0_MAX_AUDIO_MINUTES', CONFIG_DEFAULTS.maxAudioMinutes, 1, 1_000);
  const maxImageMb = int(problems, env, 'BLOG0_MAX_IMAGE_MB', CONFIG_DEFAULTS.maxImageMb, 1, 1_000);

  const e2eRaw = plain(env, 'BLOG0_E2E_BASE_URL');
  const e2eBaseUrl = e2eRaw === undefined ? null : httpUrl(e2eRaw);
  if (e2eRaw !== undefined && e2eBaseUrl === null) problems.push('BLOG0_E2E_BASE_URL must be an absolute http(s) URL');

  const trustedProxyHops = int(problems, env, 'BLOG0_TRUSTED_PROXY_HOPS', CONFIG_DEFAULTS.trustedProxyHops, 0, 10);

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    databaseUrl: databaseUrl as string,
    testDatabaseUrl,
    port,
    publicBaseUrl: publicBaseUrl as string,
    siteSlug,
    sessionSecret: new Secret(sessionSecret as string),
    openrouterApiKey: new Secret(openrouterApiKey as string),
    openrouterBaseUrl: openrouterBaseUrl as string,
    jevModel,
    jevTimeoutMs,
    logLevel: logLevel as LogLevel,
    logFile,
    adminEmail,
    adminPassword: adminPassword === undefined ? null : new Secret(adminPassword),
    adminName,
    newAdminPassword: newAdminPassword === undefined ? null : new Secret(newAdminPassword),
    storageDir,
    maxAudioMb,
    maxAudioMinutes,
    maxImageMb,
    e2eBaseUrl,
    trustedProxyHops,
    isProduction: env.NODE_ENV === 'production',
  };
}

let cached: Config | null = null;

/** Cached config from process.env. Throws ConfigError (listing every problem) when invalid. */
export function getConfig(): Config {
  if (cached === null) cached = loadConfig(process.env);
  return cached;
}

export function resetConfigForTests(): void {
  cached = null;
}
