import 'server-only';

import packageJson from '../../package.json';
import { DatabaseUrlError, DEFAULT_PGLITE_URL, parseDatabaseUrl, type DbEngine, type ParsedDatabaseUrl } from './db/url';
import { ensureDesignerSessionSecret } from './designer/secret';
import { openRouterKeyStatus } from './llm/key';

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
  /** Raw BLOG0_DATABASE_URL, or `pglite://./var/pglite` when it is absent (designer mode). */
  databaseUrl: string;
  /** The parsed target (spec/architecture.md §11.1). */
  database: ParsedDatabaseUrl;
  dbEngine: DbEngine;
  /** True when BLOG0_DATABASE_URL was absent/empty and the embedded default is in use. */
  databaseUrlDefaulted: boolean;
  testDatabaseUrl: string | null;
  port: number;
  publicBaseUrl: string;
  siteSlug: string;
  sessionSecret: Secret;
  /** 'env' = BLOG0_SESSION_SECRET; 'generated' = designer mode's var/pglite-session-secret. */
  sessionSecretSource: 'env' | 'generated';
  /** null only on the pglite engine with no (or a placeholder) key — Jev then answers LLM_NOT_CONFIGURED. */
  openrouterApiKey: Secret | null;
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

/**
 * Validates one database URL variable alone (for db:* scripts, which must not need the OpenRouter
 * key). Absent → the embedded PGlite default (designer mode). Throws ConfigError.
 */
export function loadDatabaseTarget(env: Env, name = 'BLOG0_DATABASE_URL'): ParsedDatabaseUrl {
  try {
    return parseDatabaseUrl(env[name], name);
  } catch (error) {
    if (error instanceof DatabaseUrlError) throw new ConfigError([error.message]);
    throw error;
  }
}

/** A variable that must be a server Postgres URL (BLOG0_TEST_DATABASE_URL, `db:create`). Throws ConfigError. */
export function loadDatabaseUrl(env: Env, name = 'BLOG0_DATABASE_URL'): string {
  const value = plain(env, name);
  if (value === undefined) throw new ConfigError([`${name} is required (e.g. postgres://sai@localhost:5432/blog0_dev)`]);
  if (!isPostgresUrl(value)) throw new ConfigError([`${name} must be a postgres:// URL with a database name`]);
  return value;
}

export const PRODUCTION_DATABASE_URL_REQUIRED =
  'BLOG0_DATABASE_URL is required in production; set postgres://… or explicitly pglite://… to opt in';

export interface LoadConfigOptions {
  /**
   * Supplies the session secret on the pglite engine when BLOG0_SESSION_SECRET is absent.
   * Default: read/generate `var/pglite-session-secret` (mode 0600). Tests pass a stub.
   */
  designerSessionSecret?: () => string;
}

/**
 * env → Config, or throws one ConfigError listing every problem. Pure except on the pglite engine
 * with no BLOG0_SESSION_SECRET, where `options.designerSessionSecret` (default: the persisted
 * designer secret file) supplies the secret.
 */
export function loadConfig(env: Env, options: LoadConfigOptions = {}): Config {
  const problems: string[] = [];

  const rawDatabaseUrl = plain(env, 'BLOG0_DATABASE_URL');
  let database: ParsedDatabaseUrl | null = null;
  try {
    database = parseDatabaseUrl(rawDatabaseUrl, 'BLOG0_DATABASE_URL');
  } catch (error) {
    if (!(error instanceof DatabaseUrlError)) throw error;
    problems.push(error.message);
  }
  // Production never falls back to the embedded default silently: `pnpm start` with no database URL
  // must not quietly serve an empty PGlite site. An explicit pglite:// URL is an opt-in and still boots.
  // `next build` (NODE_ENV=production too) is exempt so the build stays env-free.
  const isProduction = env.NODE_ENV === 'production';
  if (isProduction && rawDatabaseUrl === undefined && env.NEXT_PHASE !== 'phase-production-build') {
    problems.push(PRODUCTION_DATABASE_URL_REQUIRED);
    database = null;
  }
  const isPglite = database?.engine === 'pglite';

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

  // Designer mode (pglite) relaxes the two secrets (spec/architecture.md §11.1): an absent session
  // secret is generated + persisted, an absent/placeholder OpenRouter key disables Jev only.
  let sessionSecret = secret(env, 'BLOG0_SESSION_SECRET');
  let sessionSecretSource: Config['sessionSecretSource'] = 'env';
  if (sessionSecret === undefined && isPglite) {
    sessionSecret = (options.designerSessionSecret ?? (() => ensureDesignerSessionSecret().secret))();
    sessionSecretSource = 'generated';
  }
  if (sessionSecret === undefined) {
    problems.push('BLOG0_SESSION_SECRET is required (generate one with: openssl rand -base64 48)');
  } else if (isPlaceholder(sessionSecret)) {
    problems.push(placeholderProblem('BLOG0_SESSION_SECRET'));
  } else if (sessionSecret.length < 32) {
    problems.push('BLOG0_SESSION_SECRET must be at least 32 characters (openssl rand -base64 48)');
  }

  let openrouterApiKey = secret(env, 'BLOG0_OPENROUTER_API_KEY');
  if (isPglite && openRouterKeyStatus(openrouterApiKey) !== 'real') {
    openrouterApiKey = undefined; // → null: Jev answers LLM_NOT_CONFIGURED, the TLDR tab shows the notice
  } else if (openrouterApiKey === undefined) {
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

  const target = database as ParsedDatabaseUrl;
  return {
    databaseUrl: rawDatabaseUrl ?? DEFAULT_PGLITE_URL,
    database: target,
    dbEngine: target.engine,
    databaseUrlDefaulted: rawDatabaseUrl === undefined,
    testDatabaseUrl,
    port,
    publicBaseUrl: publicBaseUrl as string,
    siteSlug,
    sessionSecret: new Secret(sessionSecret as string),
    sessionSecretSource,
    openrouterApiKey: openrouterApiKey === undefined ? null : new Secret(openrouterApiKey),
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
    isProduction,
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
