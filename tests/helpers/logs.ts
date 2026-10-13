// captureLogs(): collects structured log lines emitted through src/server/log.ts during a test.
import { addLogSink, type LogLine } from '@/server/log';

export interface CapturedLogs {
  lines: LogLine[];
  find(event: string): LogLine[];
  stop(): void;
}

export function captureLogs(): CapturedLogs {
  const lines: LogLine[] = [];
  const stop = addLogSink((line) => {
    lines.push(line);
  });
  return {
    lines,
    find: (event) => lines.filter((l) => l.event === event),
    stop,
  };
}
