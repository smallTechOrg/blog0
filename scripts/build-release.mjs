#!/usr/bin/env node
// pnpm build:release — bundles scripts/release.ts into dist/release.mjs, (Stage A)
// scripts/reset-password.ts into dist/reset-password.mjs and (Stage B, spec/architecture.md §12.7)
// scripts/newsletter-tick.ts into dist/newsletter-tick.mjs with identical options (spec/architecture.md
// §12.1), so the container runs `node release.mjs` / `node reset-password.mjs --email <e>` /
// `node newsletter-tick.mjs` without tsx, dev dependencies, the full node_modules or a repo checkout.
// The tick reaches the content pipeline (Shiki, unified) through issue snapshots: bundled, not external.
//
// Module resolution in the image: Next's standalone output (pnpm layout) exposes only a few packages
// at /app/node_modules — `@node-rs/argon2` is one of them, but `postgres` and `@electric-sql/pglite`
// live only under node_modules/.pnpm (reached by the server through hashed .next/node_modules
// links), so a bare `import 'postgres'` from /app/release.mjs would fail. Hence:
//   - `@node-rs/argon2` (native binary) stays external and loads from /app/node_modules;
//   - `postgres` (pure JS) is bundled;
//   - `@electric-sql/pglite` is replaced by a stub that throws if ever constructed: the release step
//     refuses pglite:// before opening a database, so the Postgres path never needs PGlite;
//   - `next` stays external (only reached through type-level/tree-shaken imports of the request guard).
import path from 'node:path';

import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const emptyModule = path.join(root, 'scripts', 'lib', 'empty-module.mjs');

/** The tsx-only `server-only` shim must not run in the bundle (it resolves `server-only` from disk). */
const stubServerOnlyShim = {
  name: 'stub-allow-server-only',
  setup(b) {
    b.onResolve({ filter: /(^|\/)allow-server-only$/ }, () => ({ path: emptyModule }));
  },
};

const PGLITE_STUB = `
const unavailable = () => {
  throw new Error('PGlite is not part of the bundled CLIs (release.mjs, reset-password.mjs, newsletter-tick.mjs) — they are for Postgres; in designer mode use pnpm dev:design / pnpm admin:reset-password');
};
export class PGlite { constructor() { unavailable(); } static create() { unavailable(); } }
export const types = {};
export default { PGlite, types };
`;

const stubPglite = {
  name: 'stub-pglite',
  setup(b) {
    b.onResolve({ filter: /^@electric-sql\/pglite(\/.*)?$/ }, (args) => ({ path: args.path, namespace: 'pglite-stub' }));
    b.onLoad({ filter: /.*/, namespace: 'pglite-stub' }, () => ({ contents: PGLITE_STUB, loader: 'js' }));
  },
};

/** The CLIs the image carries: same options, so all resolve modules the same way in /app. */
const ENTRIES = [
  ['scripts/release.ts', 'release.mjs'],
  ['scripts/reset-password.ts', 'reset-password.mjs'],
  ['scripts/newsletter-tick.ts', 'newsletter-tick.mjs'],
];

for (const [entry, name] of ENTRIES) {
  const outfile = path.join(root, 'dist', name);
  await build({
    absWorkingDir: root,
    entryPoints: [entry],
    outfile,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    bundle: true,
    tsconfig: 'tsconfig.json',
    alias: { 'server-only': './scripts/lib/empty-module.mjs' },
    external: ['@node-rs/argon2', 'next'],
    // Bundled CommonJS code (e.g. @next/env) uses require() and __dirname, which ESM lacks. The alias
    // avoids clashing with src/server/db/pglite.ts's own `import { createRequire } from 'node:module'`
    // (esbuild does not rename banner bindings).
    banner: {
      js: [
        "import { createRequire as __blog0CreateRequire } from 'node:module';",
        'const require = __blog0CreateRequire(import.meta.url);',
        'const __filename = import.meta.filename;',
        'const __dirname = import.meta.dirname;',
      ].join(' '),
    },
    plugins: [stubServerOnlyShim, stubPglite],
    legalComments: 'none',
    logLevel: 'warning',
  });
  console.log(`build:release: ${path.relative(root, outfile)}`);
}
