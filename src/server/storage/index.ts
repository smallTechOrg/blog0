import path from 'node:path';

import { getConfig } from '../config';
import { LocalDiskStorage } from './local-disk';
import type { Storage } from './types';

export * from './types';
export { LocalDiskStorage } from './local-disk';

// getStorage(): the process-wide storage singleton (spec/architecture.md §9.1). Local disk under
// BLOG0_STORAGE_DIR (default ./var/storage, created on first write) — designer mode needs nothing
// more. An object-storage adapter would implement the same interface later.

let singleton: Storage | null = null;

export function storageRootDir(): string {
  // BLOG0_STORAGE_DIR is runtime config, not a bundling hint: tell Turbopack not to trace it.
  return path.resolve(/* turbopackIgnore: true */ process.cwd(), getConfig().storageDir);
}

export function getStorage(): Storage {
  if (!singleton) singleton = new LocalDiskStorage(storageRootDir());
  return singleton;
}

export function resetStorageForTests(): void {
  singleton = null;
}
