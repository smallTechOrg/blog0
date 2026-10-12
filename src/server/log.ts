import 'server-only';

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { getConfig, LOG_LEVELS, type LogLevel } from './config';

// JSON-lines structured logger (spec/architecture.md §7): one object per line with
// ts, level, event, msg + context. Destinations: stdout always, BLOG0_LOG_FILE (append) when set,
// and in-memory sinks registered by tests (tests/helpers/logs.ts → captureLogs()).
// Never pass article text, passwords, tokens, keys or full emails as fields.

export interface LogLine {
  ts: string;
  level: LogLevel;
  event: string;
  msg: string;
  [field: string]: unknown;
}

export type LogFields = Record<string, unknown> & { msg?: string };
export type LogSink = (line: LogLine) => void;

interface Settings {
  level: LogLevel;
  file: string | null;
}

let settings: Settings | null = null;
const sinks = new Set<LogSink>();
let fileDirReady: string | null = null;

function resolveSettings(): Settings {
  if (settings !== null) return settings;
  try {
    const config = getConfig();
    settings = { level: config.logLevel, file: config.logFile };
  } catch {
    // Logging must work even when the rest of the config is invalid (e.g. reporting that very problem).
    const raw = (process.env.BLOG0_LOG_LEVEL ?? '').trim() as LogLevel;
    const file = (process.env.BLOG0_LOG_FILE ?? '').trim();
    settings = { level: LOG_LEVELS.includes(raw) ? raw : 'info', file: file === '' ? null : file };
  }
  return settings;
}

function serialiseValue(value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message };
  return value;
}

function write(level: LogLevel, event: string, fields: LogFields = {}): void {
  const { level: minLevel, file } = resolveSettings();
  const enabled = LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(minLevel);
  if (!enabled && sinks.size === 0) return;

  const { msg, ...rest } = fields;
  const line: LogLine = { ts: new Date().toISOString(), level, event, msg: msg ?? event };
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) line[key] = serialiseValue(value);
  }

  for (const sink of sinks) sink(line);
  if (!enabled) return;

  let text: string;
  try {
    text = JSON.stringify(line);
  } catch {
    text = JSON.stringify({ ts: line.ts, level, event, msg: line.msg, log_error: 'unserialisable fields' });
  }
  process.stdout.write(`${text}\n`);
  if (file !== null) {
    try {
      const dir = dirname(file);
      if (fileDirReady !== dir) {
        mkdirSync(dir, { recursive: true });
        fileDirReady = dir;
      }
      appendFileSync(file, `${text}\n`);
    } catch {
      // A broken log file must never take the request down; stdout still has the line.
    }
  }
}

export const log = {
  debug: (event: string, fields?: LogFields) => write('debug', event, fields),
  info: (event: string, fields?: LogFields) => write('info', event, fields),
  warn: (event: string, fields?: LogFields) => write('warn', event, fields),
  error: (event: string, fields?: LogFields) => write('error', event, fields),
};

/** Registers an in-memory sink (tests). Returns the unsubscribe function. */
export function addLogSink(sink: LogSink): () => void {
  sinks.add(sink);
  return () => {
    sinks.delete(sink);
  };
}

/** Masks an email for logs: `sai@smalltech.in` → `s***@smalltech.in`. */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

export function resetLoggerForTests(): void {
  settings = null;
  fileDirReady = null;
  sinks.clear();
}
