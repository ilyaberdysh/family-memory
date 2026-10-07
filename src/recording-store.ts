/**
 * Device-local safety copy of microphone recordings.
 *
 * Every MediaRecorder chunk is written to IndexedDB as it arrives, so a reload, a crashed tab or an
 * iPhone that killed the page does not lose what was said. A copy is deleted only after the server has
 * confirmed the material/message that uses it (forgetRecording) or after the person explicitly deletes it.
 * Every failure here degrades to "in memory only": callers keep recording and show a quiet note.
 */

export interface RecordingSession {
  id: string;
  mimeType: string;
  startedAt: string;
  updatedAt: string;
  durationSeconds: number;
  size: number;
  chunkCount: number;
  userId?: string;
  /** Family the recording was made for; recordings made before families existed have none and show everywhere. */
  familyId?: string;
  /** Human label of where it was recorded, e.g. "Архив · новый материал". */
  context: string;
  /** false while recording, or when the page died before the recorder stopped. */
  finished: boolean;
  /** A chunk could not be written: the device copy has a gap and may be cut short. */
  partial?: boolean;
}

interface StoredChunk { sessionId: string; seq: number; type: string; data: ArrayBuffer }

const DB_NAME = 'family-memory-recordings';
const DB_VERSION = 1;
const SESSIONS = 'sessions';
const CHUNKS = 'chunks';
/** An unfinished session written to this recently may still be recording in another tab. */
export const ACTIVE_ELSEWHERE_MS = 12000;

let opening: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (opening) return opening;
  const attempt = new Promise<IDBDatabase>((resolve, reject) => {
    let factory: IDBFactory | undefined;
    try { factory = globalThis.indexedDB; } catch { factory = undefined; }
    if (!factory) { reject(new Error('IndexedDB is unavailable')); return; }
    // Some Safari versions never answer the first open(); do not wait forever.
    const timer = setTimeout(() => reject(new Error('IndexedDB open timed out')), 6000);
    let request: IDBOpenDBRequest;
    try { request = factory.open(DB_NAME, DB_VERSION); } catch (error) { clearTimeout(timer); reject(error); return; }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SESSIONS)) db.createObjectStore(SESSIONS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(CHUNKS)) db.createObjectStore(CHUNKS, { keyPath: ['sessionId', 'seq'] });
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      const db = request.result;
      db.onversionchange = () => { db.close(); if (opening === attempt) opening = null; };
      db.onclose = () => { if (opening === attempt) opening = null; };
      resolve(db);
    };
    request.onerror = () => { clearTimeout(timer); reject(request.error ?? new Error('IndexedDB open failed')); };
  });
  opening = attempt;
  attempt.catch(() => { if (opening === attempt) opening = null; });
  return attempt;
}

/** Runs one transaction; `body` issues requests synchronously and returns a reader for the result after commit. */
async function transaction<T>(stores: string[], mode: IDBTransactionMode, body: (tx: IDBTransaction) => () => T): Promise<T> {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction;
    try { tx = db.transaction(stores, mode); } catch (error) { opening = null; reject(error); return; }
    let read: () => T;
    try { read = body(tx); } catch (error) { try { tx.abort(); } catch { /* already finished */ } reject(error); return; }
    tx.oncomplete = () => resolve(read());
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

const chunkRange = (id: string) => IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);

function toArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer); reader.onerror = () => reject(reader.error); reader.readAsArrayBuffer(blob); });
}

// ---- change notifications (this tab + other tabs) ----
const listeners = new Set<() => void>();
let channel: BroadcastChannel | null = null;
try { channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(DB_NAME) : null; } catch { channel = null; }
if (channel) channel.onmessage = () => { for (const listener of [...listeners]) listener(); };
function notify(broadcast = true) {
  for (const listener of [...listeners]) listener();
  if (broadcast) try { channel?.postMessage('changed'); } catch { /* other tabs refresh on focus */ }
}
export function subscribeRecordings(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }

// ---- sessions held by this tab (being recorded, or loaded into a form) are not "recovered" ----
const held = new Set<string>();
const forgotten = new Set<string>();
const filesToSessions = new WeakMap<File, string>();
export function holdRecording(id: string) { held.add(id); notify(false); }
export function releaseRecording(id: string) { if (held.delete(id)) notify(false); }
export function rememberRecording(file: File, id: string) { filesToSessions.set(file, id); }
export function recordingIdOf(file: File | null | undefined) { return file ? filesToSessions.get(file) : undefined; }

let persistenceRequested = false;
export function requestPersistentStorage() {
  if (persistenceRequested) return;
  persistenceRequested = true;
  try {
    const storage = navigator.storage;
    if (!storage?.persist) return;
    void (storage.persisted ? storage.persisted() : Promise.resolve(false)).then(already => already ? true : storage.persist()).catch(() => false);
  } catch { /* not supported */ }
}

const newId = () => typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export function recordingExtension(type: string) { return type.includes('mp4') || type.includes('m4a') || type.includes('aac') ? 'm4a' : type.includes('ogg') ? 'ogg' : type.includes('mpeg') ? 'mp3' : type.includes('wav') ? 'wav' : 'webm'; }
export function recordingFileName(type: string, startedAt: string | Date = new Date()) {
  const date = new Date(startedAt);
  const pad = (value: number) => value.toString().padStart(2, '0');
  const stamp = Number.isNaN(date.getTime()) ? '' : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}-${pad(date.getMinutes())}`;
  return `Запись ${stamp}.${recordingExtension(type)}`.replace(' .', '.');
}

export interface RecordingBackup {
  readonly id: string;
  /** Queue one MediaRecorder chunk for the device copy. Never throws. */
  append(chunk: Blob, durationSeconds: number): void;
  /** Heartbeat while paused (no chunks arrive), so other tabs keep treating the session as live. */
  touch(durationSeconds: number): void;
  /** Mark the device copy complete; resolves true when every chunk was stored. */
  finish(durationSeconds: number): Promise<boolean>;
}

/** Starts a device copy for a new recording and holds it for this tab until releaseRecording(id). */
export function startRecordingBackup(meta: { mimeType: string; userId?: string; familyId?: string; context: string }, onUnavailable: () => void): RecordingBackup {
  requestPersistentStorage();
  const id = newId();
  held.add(id);
  const startedAt = new Date().toISOString();
  const session: RecordingSession = { id, mimeType: meta.mimeType, startedAt, updatedAt: startedAt, durationSeconds: 0, size: 0, chunkCount: 0, userId: meta.userId, familyId: meta.familyId, context: meta.context, finished: false };
  let failed = false; let seq = 0;
  let queue: Promise<void> = transaction([SESSIONS], 'readwrite', tx => { tx.objectStore(SESSIONS).put({ ...session }); return () => undefined; });
  const fail = () => {
    if (failed) return;
    failed = true; session.partial = true;
    try { onUnavailable(); } catch { /* UI already gone */ }
    // Best effort: if earlier chunks were stored, say that the copy is incomplete.
    if (session.chunkCount) void transaction([SESSIONS], 'readwrite', tx => { tx.objectStore(SESSIONS).put({ ...session }); return () => undefined; }).catch(() => {});
  };
  queue = queue.catch(fail);
  return {
    id,
    append(chunk, durationSeconds) {
      if (failed || !chunk.size) return;
      const current = seq++;
      queue = queue.then(async () => {
        if (failed) return;
        const data = await toArrayBuffer(chunk);
        const next: RecordingSession = { ...session, mimeType: session.mimeType || chunk.type, updatedAt: new Date().toISOString(), durationSeconds, size: session.size + chunk.size, chunkCount: current + 1 };
        await transaction([SESSIONS, CHUNKS], 'readwrite', tx => {
          tx.objectStore(CHUNKS).put({ sessionId: id, seq: current, type: chunk.type, data } satisfies StoredChunk);
          tx.objectStore(SESSIONS).put(next);
          return () => undefined;
        });
        Object.assign(session, next);
      }).catch(fail);
    },
    touch(durationSeconds) {
      queue = queue.then(async () => {
        if (failed) return;
        Object.assign(session, { durationSeconds, updatedAt: new Date().toISOString() });
        await transaction([SESSIONS], 'readwrite', tx => { tx.objectStore(SESSIONS).put({ ...session }); return () => undefined; });
      }).catch(fail);
    },
    finish(durationSeconds) {
      queue = queue.then(async () => {
        if (failed) return;
        Object.assign(session, { finished: true, durationSeconds, updatedAt: new Date().toISOString() });
        await transaction([SESSIONS], 'readwrite', tx => { tx.objectStore(SESSIONS).put({ ...session }); return () => undefined; });
      }).catch(fail);
      return queue.then(() => { notify(); return !failed; });
    },
  };
}

export function isRecordingElsewhere(session: RecordingSession) {
  return !session.finished && Date.now() - Date.parse(session.updatedAt) < ACTIVE_ELSEWHERE_MS;
}

/** Recordings on this device that never reached the server, newest first. Rejects if IndexedDB is unavailable. */
export async function listRecordings(userId?: string, familyId?: string): Promise<RecordingSession[]> {
  const all = await transaction([SESSIONS], 'readonly', tx => { const request = tx.objectStore(SESSIONS).getAll(); return () => request.result as RecordingSession[]; });
  const visible: RecordingSession[] = [];
  for (const session of all) {
    if (held.has(session.id) || forgotten.has(session.id)) continue;
    if (!session.chunkCount) {
      // A recording that never produced sound; clean it up once it is clearly not in progress.
      if (Date.now() - Date.parse(session.updatedAt) > 60000) void deleteRecording(session.id, false).catch(() => {});
      continue;
    }
    if (userId && session.userId && session.userId !== userId) continue;
    if (familyId && session.familyId && session.familyId !== familyId) continue;
    visible.push(session);
  }
  return visible.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** Rebuilds the recording as a File; the File is linked to the session for forgetRecording. */
export async function loadRecording(id: string): Promise<File> {
  const { session, chunks } = await transaction([SESSIONS, CHUNKS], 'readonly', tx => {
    const sessionRequest = tx.objectStore(SESSIONS).get(id);
    const chunkRequest = tx.objectStore(CHUNKS).getAll(chunkRange(id));
    return () => ({ session: sessionRequest.result as RecordingSession | undefined, chunks: chunkRequest.result as StoredChunk[] });
  });
  if (!session || !chunks.length) throw new Error('Recording not found');
  const type = session.mimeType || chunks[0].type || 'audio/webm';
  const file = new File(chunks.sort((a, b) => a.seq - b.seq).map(chunk => chunk.data), recordingFileName(type, session.startedAt), { type });
  rememberRecording(file, id);
  return file;
}

export async function deleteRecording(id: string, broadcast = true): Promise<void> {
  await transaction([SESSIONS, CHUNKS], 'readwrite', tx => { tx.objectStore(CHUNKS).delete(chunkRange(id)); tx.objectStore(SESSIONS).delete(id); return () => undefined; });
  notify(broadcast);
}

/** Call only after the server confirmed the message/material that uses this file. */
export async function forgetRecording(file: File | null | undefined): Promise<void> {
  const id = recordingIdOf(file);
  if (!id) return;
  forgotten.add(id); held.delete(id); notify(false);
  try { await deleteRecording(id); } catch { /* hidden for this page; worst case it is offered again after a reload */ }
}
