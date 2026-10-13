import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat, readFile, rename, open } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

import { isValidStorageKey, StorageError, type ByteRange, type Storage, type StorageStat, type StorageStream, type StoredObject } from './types';

// LocalDiskStorage (spec/architecture.md §9.1): files under `rootDir/<key>`. Every method first
// asserts isValidStorageKey(key) (else BAD_KEY) and that the resolved path stays inside rootDir
// (belt and braces). put() is atomic: temp file in the same directory → fsync → rename; over
// maxBytes → TOO_LARGE with nothing left on disk.

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === code;
}

export class LocalDiskStorage implements Storage {
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
  }

  /** Absolute path for a key, or BAD_KEY. Never touches the filesystem. */
  pathFor(key: string): string {
    if (!isValidStorageKey(key)) throw new StorageError('BAD_KEY', 'Invalid storage key');
    const full = path.resolve(this.rootDir, key);
    if (!full.startsWith(this.rootDir + path.sep)) throw new StorageError('BAD_KEY', 'Storage key escapes the storage root');
    return full;
  }

  async put(key: string, body: Buffer | ReadableStream<Uint8Array>, opts: { maxBytes: number }): Promise<StoredObject> {
    const full = this.pathFor(key);
    const dir = path.dirname(full);
    const tmp = path.join(dir, `.${path.basename(full)}.${randomUUID()}.tmp`);
    const maxBytes = Math.max(0, Math.floor(opts.maxBytes));
    const hash = createHash('sha256');
    let size = 0;

    try {
      await mkdir(dir, { recursive: true });
    } catch (error) {
      throw new StorageError('IO', `Cannot create storage directory: ${(error as Error).message}`);
    }

    try {
      const source: Readable = Buffer.isBuffer(body) ? Readable.from([body]) : Readable.fromWeb(body as import('node:stream/web').ReadableStream<Uint8Array>);
      const sink = createWriteStream(tmp, { flags: 'wx', mode: 0o644 });
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const fail = (error: Error): void => {
          if (settled) return;
          settled = true;
          source.destroy();
          sink.destroy();
          reject(error);
        };
        source.on('error', (e) => fail(new StorageError('IO', `Upload stream failed: ${e.message}`)));
        sink.on('error', (e) => fail(new StorageError('IO', `Cannot write file: ${e.message}`)));
        source.on('data', (chunk: Buffer | string) => {
          const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          size += buf.length;
          if (size > maxBytes) {
            fail(new StorageError('TOO_LARGE', `Object exceeds ${maxBytes} bytes`));
            return;
          }
          hash.update(buf);
          if (!sink.write(buf)) {
            source.pause();
            sink.once('drain', () => source.resume());
          }
        });
        source.on('end', () => {
          sink.end(() => {
            if (settled) return;
            settled = true;
            resolve();
          });
        });
      });
      const fh = await open(tmp, 'r+');
      try {
        await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmp, full);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      if (error instanceof StorageError) throw error;
      throw new StorageError('IO', `Cannot store object: ${(error as Error).message}`);
    }

    return { key, size, sha256: hash.digest('hex') };
  }

  async get(key: string): Promise<Buffer | null> {
    const full = this.pathFor(key);
    try {
      return await readFile(full);
    } catch (error) {
      if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return null;
      throw new StorageError('IO', `Cannot read object: ${(error as Error).message}`);
    }
  }

  async stat(key: string): Promise<StorageStat | null> {
    const full = this.pathFor(key);
    try {
      const s = await stat(full);
      if (!s.isFile()) return null;
      return { size: s.size, mtime: s.mtime };
    } catch (error) {
      if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return null;
      throw new StorageError('IO', `Cannot stat object: ${(error as Error).message}`);
    }
  }

  async delete(key: string): Promise<void> {
    const full = this.pathFor(key);
    try {
      await rm(full, { force: true });
    } catch (error) {
      throw new StorageError('IO', `Cannot delete object: ${(error as Error).message}`);
    }
  }

  async stream(key: string, range?: ByteRange): Promise<StorageStream> {
    const full = this.pathFor(key);
    const s = await this.stat(key);
    if (!s) throw new StorageError('NOT_FOUND', 'Object not found');
    if (range) {
      const ok =
        Number.isInteger(range.start) && Number.isInteger(range.end) && range.start >= 0 && range.start <= range.end && range.end < s.size;
      if (!ok) throw new StorageError('BAD_RANGE', 'Range outside the object');
    }
    if (s.size === 0 || (range && range.end < range.start)) {
      return { stream: new ReadableStream<Uint8Array>({ start: (c) => c.close() }), size: s.size, range: range ?? null };
    }
    const nodeStream = createReadStream(full, range ? { start: range.start, end: range.end } : {});
    const web = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
    return { stream: web, size: s.size, range: range ?? null };
  }
}
