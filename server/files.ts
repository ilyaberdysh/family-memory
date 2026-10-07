import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, statfsSync } from 'node:fs';
import { open, readdir, rename, stat, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Request } from 'express';
import type { StorageEngine } from 'multer';
import type { PreviewStatus, StorageStatus, UploadedFile } from '../shared/types.js';

/** Server-only file row. `path`/`previewPath` are bare names inside DATA_DIR/files; originals are immutable. */
export type FileRecord = UploadedFile & {
  createdBy: string; path: string; sha256?: string; createdAt?: string;
  previewPath?: string; previewMime?: string; previewSize?: number; previewSha256?: string; previewAttempts?: number;
};
export type StoredUpload = Express.Multer.File & { sha256: string };

/** Legacy rows predate previewStatus: a recorded preview path means a finished browser copy. */
export const previewState = (file: FileRecord): PreviewStatus => file.previewStatus ?? (file.previewPath ? 'ready' : 'none');
export const previewReady = (file: FileRecord) => previewState(file) === 'ready' && !!file.previewPath && !!file.previewMime && !!file.previewSize;
export function clientFile(file: FileRecord): UploadedFile {
  const ready = previewReady(file);
  return { id: file.id, name: file.name, mime: ready ? file.previewMime! : file.mime, size: ready ? file.previewSize! : file.size, url: file.url, previewStatus: previewState(file), previewError: file.previewError ?? null };
}

export async function fsyncPath(path: string) {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Directory fsync makes a completed rename survive power loss; some platforms refuse it, which is harmless there. */
export async function fsyncDirectory(path: string) {
  try { await fsyncPath(path); } catch (error) { if (!['EISDIR', 'EPERM', 'EINVAL', 'EBADF'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
}

export async function sha256File(path: string) {
  const hash = createHash('sha256');
  const handle = await open(path, 'r');
  try { for await (const chunk of handle.createReadStream()) hash.update(chunk); } finally { await handle.close(); }
  return hash.digest('hex');
}

/**
 * Streams an upload into files/.incoming while hashing it, then fsyncs the bytes.
 * The caller renames it into files/ only after validation, so files/ never holds half-written originals.
 */
export class DurableUploadStorage implements StorageEngine {
  constructor(private readonly directory: string) {}
  _handleFile(_req: Request, file: Express.Multer.File, callback: (error?: unknown, info?: Partial<StoredUpload>) => void) {
    const filename = randomBytes(16).toString('hex');
    const path = join(this.directory, filename);
    const hash = createHash('sha256'); let size = 0;
    const meter = new Transform({ transform(chunk: Buffer, _encoding, done) { hash.update(chunk); size += chunk.length; done(null, chunk); } });
    void (async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await pipeline(file.stream, meter, createWriteStream(path, { flags: 'wx', mode: 0o600 }));
      await fsyncPath(path);
    })().then(() => callback(null, { destination: this.directory, filename, path, size, sha256: hash.digest('hex') }), async error => {
      await unlink(path).catch(() => {});
      callback(error);
    });
  }
  _removeFile(_req: Request, file: Express.Multer.File, callback: (error: Error | null) => void) {
    unlink(file.path).then(() => callback(null), () => callback(null));
  }
}

/**
 * Where a family's originals and browser copies live. Local disk today (files/<familyId>/<name>);
 * an object-storage implementation (GCS/S3) only has to provide the same four operations.
 */
export interface BlobStore {
  /** Moves a validated, fsynced staging file into the family's storage and returns its stored name. */
  commit(upload: StoredUpload, familyId: string): Promise<string>;
  /** A readable local path for ffmpeg/transcription (object storage would download to a temporary file). */
  localPath(familyId: string, name: string): string;
  read(familyId: string, name: string, range?: { start: number; end: number }): NodeJS.ReadableStream;
  remove(familyId: string, name: string): Promise<void>;
}
const FAMILY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STORED_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/;
export class LocalBlobStore implements BlobStore {
  constructor(readonly root: string) {}
  directory(familyId: string) { if (!FAMILY_ID.test(familyId)) throw new Error('Некорректный идентификатор семьи.'); return join(this.root, familyId); }
  localPath(familyId: string, name: string) { if (!STORED_NAME.test(name)) throw new Error('Некорректное имя файла.'); return join(this.directory(familyId), name); }
  async commit(upload: StoredUpload, familyId: string) {
    const directory = this.directory(familyId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await rename(upload.path, join(directory, upload.filename));
    await fsyncDirectory(directory);
    return upload.filename;
  }
  read(familyId: string, name: string, range?: { start: number; end: number }) { return createReadStream(this.localPath(familyId, name), range); }
  async remove(familyId: string, name: string) { await unlink(this.localPath(familyId, name)).catch(() => {}); }
}

/** Leftovers in .incoming were never acknowledged to anyone; old ones are interrupted uploads. */
export async function sweepIncoming(directory: string, olderThanMs = 86_400_000) {
  const names = await readdir(directory).catch(() => [] as string[]);
  for (const name of names) {
    const path = join(directory, name);
    const info = await stat(path).catch(() => null);
    if (info?.isFile() && Date.now() - info.mtimeMs > olderThanMs) await unlink(path).catch(() => {});
  }
}

export function storageStatus(directory: string, minimumFreeBytes: number): StorageStatus {
  try {
    const info = statfsSync(directory);
    const freeBytes = Number(info.bavail) * Number(info.bsize);
    return { freeBytes, totalBytes: Number(info.blocks) * Number(info.bsize), low: freeBytes < minimumFreeBytes };
  } catch { return { freeBytes: null, totalBytes: null, low: false }; }
}
