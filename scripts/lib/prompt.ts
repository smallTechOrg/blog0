// Hidden terminal prompt shared by the admin CLIs (admin:create, admin:reset-password). Imports
// nothing from src/ so the bundled reset-password.mjs stays small.

/** Reads one line from the terminal without echoing it. Ctrl-C rejects with `cancelled`. */
export function promptHidden(question: string, cancelled: () => Error = () => new Error('Cancelled.')): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          cleanup();
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          cleanup();
          process.stdout.write('\n');
          reject(cancelled());
          return;
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    const cleanup = (): void => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on('data', onData);
  });
}
