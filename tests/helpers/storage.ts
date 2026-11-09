// resetStorage(): wipes BLOG0_STORAGE_DIR (the integration setup points it at var/storage-test)
// and resets the storage singleton so each test starts from an empty disk.
import { rmSync } from 'node:fs';
import path from 'node:path';

import { resetStorageForTests } from '@/server/storage';

export function testStorageDir(): string {
  const dir = (process.env.BLOG0_STORAGE_DIR ?? '').trim();
  if (dir === '' || !/storage-(test|e2e)/.test(dir)) {
    throw new Error(`refusing to wipe BLOG0_STORAGE_DIR=${JSON.stringify(dir)} — tests only touch a var/storage-test-style dir`);
  }
  return path.resolve(process.cwd(), dir);
}

export function resetStorage(): string {
  const dir = testStorageDir();
  rmSync(dir, { recursive: true, force: true });
  resetStorageForTests();
  return dir;
}
