// `server-only` throws unless resolved under the React Server Components condition, which only
// Next.js applies. Node-side entry points that legitimately import src/server/** (tsx scripts,
// drizzle-kit, Playwright global setup) import this module FIRST: it maps `server-only` to the
// package's own no-op `empty.js`. Never import this from src/ — inside Next the guard stays active.
import Module from 'node:module';
import path from 'node:path';

type ResolveFilename = (request: string, ...rest: unknown[]) => string;
const ModuleInternals = Module as unknown as { _resolveFilename: ResolveFilename; __blog0ServerOnlyShim?: true };

if (!ModuleInternals.__blog0ServerOnlyShim) {
  const original = ModuleInternals._resolveFilename;
  const resolvedIndex = original.call(Module, 'server-only', module, false);
  const emptyModule = path.join(path.dirname(resolvedIndex), 'empty.js');
  ModuleInternals._resolveFilename = function resolveFilename(request: string, ...rest: unknown[]): string {
    if (request === 'server-only') return emptyModule;
    return original.call(this, request, ...rest);
  };
  ModuleInternals.__blog0ServerOnlyShim = true;
}

export {};
