// Next's bundled path-to-regexp (the matcher behind next.config `source` patterns) ships no types.
declare module 'next/dist/compiled/path-to-regexp' {
  export function match(source: string): (path: string) => false | { path: string; params: Record<string, string | string[]> };
}
