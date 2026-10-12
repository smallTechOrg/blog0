// Stand-in for `server-only` (and the tsx-only shim scripts/lib/allow-server-only.ts) inside the
// esbuild bundle dist/release.mjs (scripts/build-release.mjs): the release step is a plain Node
// process, never a React client bundle, so the guard has nothing to protect there.
export {};
